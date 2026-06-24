const { spawn } = require("child_process");
const path = require("path");
const { db, transaction } = require("../db");
const { syncProspectsForListItem } = require("./prospect-sync");
const { ensureChrome } = require(path.join(__dirname, "..", "..", "shared", "chrome-launcher"));

const PYTHON = process.env.PYTHON_EXE || "python";
const RUNNER = path.join(__dirname, "..", "..", "python", "run_processor.py");
const STEP_TIMEOUT_MS = Number(process.env.PROCESSOR_STEP_TIMEOUT_MS || 25 * 60 * 1000);

const ALL_STEPS = ["google_serp", "linkedin", "instagram", "zfbot", "crunchbase"];

const STEP_LABELS = {
  google_serp: "Google",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  zfbot: "ZFBot",
  crunchbase: "Crunchbase",
};

const RESULTS_MODES = ["merge", "overwrite"];
const STEP_MODES = ["selected", "remaining"];

// Alternate TLDs for Method 2 Google prospecting (site:*.<tld> "company name").
const GOOGLE_PROSPECT_TLDS = ["net", "org", "io", "au", "ca"];

let state = {
  jobId: null,
  listId: null,
  status: "idle",
  paused: false,
  stopped: false,
  itemIds: [],
  currentIndex: 0,
  currentStep: null,
  steps: [...ALL_STEPS],
  stepMode: "selected",
  resultsMode: "overwrite",
  googleStrategy: "selenium",
  googleWaitMin: 10,
};

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return [...ALL_STEPS];
  const requested = new Set(steps.filter((s) => ALL_STEPS.includes(s)));
  return ALL_STEPS.filter((s) => requested.has(s));
}

function parseProcProgress(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => ALL_STEPS.includes(s)) : [];
  } catch {
    return [];
  }
}

function getCompletedStepsForItem(item) {
  const fromProgress = parseProcProgress(item.proc_progress);
  if (fromProgress.length) return fromProgress;

  if (item.proc_status === "done") return [...ALL_STEPS];

  const stepsWithResults = db.prepare(`
    SELECT DISTINCT step FROM processing_results WHERE list_item_id = ?
  `).all(item.id).map((r) => r.step);
  if (stepsWithResults.length) {
    return ALL_STEPS.filter((s) => stepsWithResults.includes(s));
  }
  return [];
}

function resolveStepsForItem(item, requestedSteps, stepMode) {
  const pool = normalizeSteps(requestedSteps);
  if (stepMode === "remaining") {
    const completed = new Set(getCompletedStepsForItem(item));
    return pool.filter((s) => !completed.has(s));
  }
  return pool;
}

function removeStepsFromProgress(listItemId, steps) {
  const row = db.prepare("SELECT id, proc_progress, proc_status FROM domain_list_items WHERE id=?").get(listItemId);
  const existing = new Set(getCompletedStepsForItem(row || { id: listItemId, proc_progress: null, proc_status: null }));
  for (const step of steps) existing.delete(step);
  const completed = ALL_STEPS.filter((s) => existing.has(s));
  const proc_status = completed.length === ALL_STEPS.length
    ? "done"
    : completed.length > 0
      ? "partial"
      : "pending";
  db.prepare(`
    UPDATE domain_list_items SET proc_progress=?, proc_status=?, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(completed), proc_status, listItemId);
}

function updateItemProgress(listItemId, newlyCompletedSteps) {
  const row = db.prepare("SELECT id, proc_progress, proc_status FROM domain_list_items WHERE id=?").get(listItemId);
  const existing = new Set(getCompletedStepsForItem(row || { id: listItemId, proc_progress: null, proc_status: null }));
  for (const step of newlyCompletedSteps) existing.add(step);
  const completed = ALL_STEPS.filter((s) => existing.has(s));
  const proc_status = completed.length === ALL_STEPS.length
    ? "done"
    : completed.length > 0
      ? "partial"
      : "pending";
  db.prepare(`
    UPDATE domain_list_items SET proc_progress=?, proc_status=?, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(completed), proc_status, listItemId);
}

function getState() {
  return {
    ...state,
    allSteps: ALL_STEPS,
    stepLabels: STEP_LABELS,
    steps: state.steps || [...ALL_STEPS],
    stepMode: state.stepMode || "selected",
  };
}

function normalizeResultDomain(domain) {
  if (!domain) return "";
  return String(domain).toLowerCase().replace(/^www\./, "").trim();
}

function normalizeResultUrl(url) {
  if (!url) return "";
  return String(url).toLowerCase().replace(/\/+$/, "").trim();
}

function resultIdentityKey(r) {
  const url = normalizeResultUrl(r.url);
  if (url) return `url:${url}`;
  const domain = normalizeResultDomain(r.domain || r.result_domain);
  if (domain) return `domain:${domain}`;
  const title = (r.title || "").trim().toLowerCase();
  if (title) return `title:${title}`;
  return null;
}

function clearResultsForSteps(listItemId, steps) {
  const delStep = db.prepare("DELETE FROM processing_results WHERE list_item_id = ? AND step = ?");
  for (const step of steps) {
    delStep.run(listItemId, step);
  }
  updateSummaryCounts(listItemId);
}

function clearResultsForItem(listItemId) {
  clearResultsForSteps(listItemId, ALL_STEPS);
}

function runPython(step, payload) {
  return runPythonWithProgress(step, payload, null);
}

function runPythonWithProgress(step, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ step, ...payload });
    const proc = spawn(PYTHON, [RUNNER], {
      cwd: path.dirname(RUNNER),
      env: { ...process.env },
      windowsHide: !onProgress,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let stderrBuf = "";

    const emitProgressLines = (chunk) => {
      if (!onProgress) return;
      stderrBuf += chunk;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "progress") onProgress(obj);
        } catch {
          // ignore non-JSON stderr
        }
      }
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error(`${step} timed out after ${Math.round(STEP_TIMEOUT_MS / 60000)} minutes`));
    }, STEP_TIMEOUT_MS);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      emitProgressLines(text);
    });
    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stderrBuf.trim() && onProgress) emitProgressLines(`${stderrBuf}\n`);
      if (stderr.trim()) {
        console.error(`[processor:${step}]`, stderr.trim());
      }
      if (code !== 0) {
        return reject(new Error(stderr || `Python exited ${code}`));
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (e) {
        reject(new Error(`Invalid JSON from processor: ${stdout.slice(0, 200)}`));
      }
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function deriveWords(domain) {
  const raw = (domain || "").split(".")[0] || "";
  const full = raw.toLowerCase();
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const splitSuffixes = [
    "tech", "ai", "labs", "lab", "digital", "media", "cloud", "soft", "software",
    "systems", "system", "group", "global", "capital", "finance", "fintech", "pay",
    "store", "shop", "studio", "marketing", "consulting", "logistics", "health",
  ];
  const rawParts = spaced.split(/[^a-zA-Z0-9]+/).map((x) => x.toLowerCase()).filter(Boolean);
  const heuristicParts = [];
  for (const suf of splitSuffixes) {
    if (full.endsWith(suf) && full.length > suf.length + 2) {
      const head = full.slice(0, -suf.length);
      heuristicParts.push(head, suf);
      break;
    }
  }
  let arr = [...new Set([full, ...rawParts, ...heuristicParts])];
  const hasLong = arr.some((x) => x.length > 3);
  arr = arr.filter((t) => t.length > 2 || !hasLong);
  return [...new Set(arr)].filter(Boolean);
}

function brandSearchQuery(domain) {
  const raw = (domain || "").split(".")[0] || "";
  const full = raw.toLowerCase().trim();
  if (!full) return "";

  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const parts = spaced.split(/[^a-zA-Z0-9]+/).map((x) => x.toLowerCase()).filter((p) => p.length > 1);

  const splitSuffixes = [
    "tech", "ai", "labs", "lab", "digital", "media", "cloud", "soft", "software",
    "systems", "system", "group", "global", "capital", "finance", "fintech", "pay",
    "store", "shop", "studio", "marketing", "consulting", "logistics", "health",
  ];

  if (parts.length <= 1) {
    for (const suf of splitSuffixes) {
      if (full.endsWith(suf) && full.length > suf.length + 2) {
        return `${full.slice(0, -suf.length)} ${suf}`;
      }
    }
    return full;
  }
  if (parts.length > 2) return `${parts.slice(0, -1).join("")} ${parts[parts.length - 1]}`;
  return parts.join(" ");
}

function companyNameCompact(domain) {
  const raw = (domain || "").split(".")[0] || "";
  return raw.toLowerCase().trim();
}

/**
 * Build the full Google prospecting search queue for a domain.
 *
 * Method 1 — spaced company name (existing behavior)
 * Method 2 — alternate TLD site searches: site:*.<tld> "company name"
 * Method 3 — compact name without spaces: "companyname"
 */
function buildGoogleSearchQueries(domain, prospectTlds = GOOGLE_PROSPECT_TLDS) {
  const spaced = brandSearchQuery(domain);
  const compact = companyNameCompact(domain);
  const queries = [];
  const seen = new Set();

  const add = (query) => {
    const key = query.trim().toLowerCase();
    if (query && !seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
  };

  // Method 1: primary spaced-name search (unchanged).
  if (spaced) add(spaced);

  // Method 2: find prospects on alternate TLDs / ccTLDs.
  if (spaced) {
    for (const tld of prospectTlds) {
      const tldClean = String(tld || "").trim().replace(/^\./, "");
      if (tldClean) add(`site:*.${tldClean} "${spaced}"`);
    }
  }

  // Method 3: compact name — surfaces variants like montarygroup.net, montary-group.com.
  if (compact && spaced && spaced.includes(" ")) {
    add(`"${compact}"`);
  }

  return queries;
}

function saveResults(listItemId, step, results, mode = "overwrite") {
  const ins = db.prepare(`
    INSERT INTO processing_results (list_item_id, step, match_type, result_domain, title, snippet, url, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const delStep = db.prepare("DELETE FROM processing_results WHERE list_item_id = ? AND step = ?");
  const existingRows = db.prepare(`
    SELECT url, result_domain, title FROM processing_results
    WHERE list_item_id = ? AND step = ?
  `).all(listItemId, step);

  let added = 0;
  let skipped = 0;

  transaction(() => {
    if (mode === "overwrite") {
      delStep.run(listItemId, step);
    }

    const seen = new Set();
    if (mode === "merge") {
      for (const row of existingRows) {
        const key = resultIdentityKey(row);
        if (key) seen.add(key);
      }
    }

    for (const r of results || []) {
      if (mode === "merge") {
        const key = resultIdentityKey(r);
        if (key && seen.has(key)) {
          skipped++;
          continue;
        }
        if (key) seen.add(key);
      }

      ins.run(
        listItemId,
        step,
        r.match_type || r.matchType || "unknown",
        r.domain || r.result_domain || null,
        r.title || null,
        r.snippet || null,
        r.url || null,
        r.extra ? JSON.stringify(r.extra) : null
      );
      added++;
    }
  });

  return { added, skipped };
}

function updateSummaryCounts(listItemId) {
  const counts = db.prepare(`
    SELECT step, match_type, COUNT(*) AS n
    FROM processing_results WHERE list_item_id = ?
    GROUP BY step, match_type
  `).all(listItemId);

  const c = {
    google_exact: 0, google_partial: 0, google_title: 0,
    linkedin_exact: 0, linkedin_partial: 0,
    instagram_exact: 0, instagram_partial: 0,
    zfbot_count: 0,
    crunchbase_exact: 0, crunchbase_partial: 0,
  };

  for (const row of counts) {
    const n = row.n;
    if (row.step === "google_serp") {
      if (row.match_type === "exact") c.google_exact = n;
      else if (row.match_type === "partial") c.google_partial = n;
      else if (row.match_type === "title") c.google_title = n;
    } else if (row.step === "linkedin") {
      // LI column shows total LinkedIn hits (exact + partial + title + others).
      c.linkedin_exact += n;
      if (row.match_type !== "exact") c.linkedin_partial += n;
    } else if (row.step === "instagram") {
      // IG column shows total Instagram hits (exact + partial + title + others).
      c.instagram_exact += n;
      if (row.match_type !== "exact") c.instagram_partial += n;
    } else if (row.step === "zfbot") {
      c.zfbot_count += n;
    } else if (row.step === "crunchbase") {
      // CB column shows total Crunchbase hits (exact + partial + title + others).
      c.crunchbase_exact += n;
      if (row.match_type !== "exact") c.crunchbase_partial += n;
    }
  }

  db.prepare(`
    UPDATE domain_list_items SET
      google_exact=?, google_partial=?, google_title=?,
      linkedin_exact=?, linkedin_partial=?,
      instagram_exact=?, instagram_partial=?,
      zfbot_count=?, crunchbase_exact=?, crunchbase_partial=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    c.google_exact, c.google_partial, c.google_title,
    c.linkedin_exact, c.linkedin_partial,
    c.instagram_exact, c.instagram_partial,
    c.zfbot_count, c.crunchbase_exact, c.crunchbase_partial,
    listItemId
  );

  db.prepare(`
    UPDATE campaign_domains SET
      google_exact=?, google_partial=?,
      linkedin_exact=?, instagram_exact=?,
      zfbot_count=?, crunchbase_exact=?
    WHERE list_item_id=?
  `).run(
    c.google_exact, c.google_partial,
    c.linkedin_exact, c.instagram_exact,
    c.zfbot_count, c.crunchbase_exact,
    listItemId
  );

  return c;
}

async function processOneItem(
  item,
  steps,
  resultsMode = "overwrite",
  googleStrategy = "selenium",
  googleWaitMin = 10
) {
  if (!steps.length) {
    console.log(`[processor] ${item.domain} → all requested steps already complete, skipping`);
    return;
  }

  const words = deriveWords(item.domain);
  const rowData = item.row_data ? JSON.parse(item.row_data) : {};
  const registeredTLDs = rowData.registeredTLDs || rowData.registered_tlds || [];

  if (resultsMode === "overwrite") {
    clearResultsForSteps(item.id, steps);
    removeStepsFromProgress(item.id, steps);
  }

  db.prepare("UPDATE domain_list_items SET proc_status='processing', updated_at=datetime('now') WHERE id=?").run(item.id);

  const completedStepsThisRun = [];

  for (const step of steps) {
    while (state.paused && !state.stopped) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (state.stopped) break;

    state.currentStep = step;
    db.prepare("UPDATE processing_jobs SET current_step=?, updated_at=datetime('now') WHERE id=?").run(step, state.jobId);

    const googleQueries = buildGoogleSearchQueries(item.domain);
    const opts = {
      domain: item.domain,
      words,
      search_query: brandSearchQuery(item.domain),
      registered_tlds: registeredTLDs,
      max_pages: step === "google_serp" ? 3 : step === "linkedin" || step === "instagram" || step === "crunchbase" ? 3 : 1,
      google_strategy: googleStrategy,
      google_wait_min: googleWaitMin,
      step_timeout_sec: Math.round(STEP_TIMEOUT_MS / 1000),
      zfbot_email: process.env.ZFBOT_EMAIL,
      zfbot_password: process.env.ZFBOT_PASSWORD,
    };
    if (step === "google_serp") {
      opts.search_queries = googleQueries;
    }

    const stepLabel = step === "google_serp" && googleQueries.length > 1
      ? `${step} (${googleQueries.length} queries)`
      : step;
    console.log(`[processor] ${item.domain} → step ${stepLabel}`);
    let stepSucceeded = false;
    try {
      const out = await runPython(step, opts);
      if (out.ok === false) {
        console.error(`[processor] ${step} failed for ${item.domain}:`, out.error || "unknown error");
        if (step === "zfbot") {
          console.error(`[processor] zfbot inputs: dom_s=${out.dom_s} dom_e=${out.dom_e}`);
        }
      } else if (Array.isArray(out.results)) {
        stepSucceeded = true;
        const { added, skipped } = saveResults(item.id, step, out.results, resultsMode);
        updateSummaryCounts(item.id);
        const saveNote = resultsMode === "merge" && skipped
          ? ` (${added} added, ${skipped} skipped as duplicates)`
          : "";
        console.log(
          `[processor] ${step} for ${item.domain}: ${added} results saved`
          + saveNote
          + (out.raw_count != null ? ` (raw: ${out.raw_count})` : "")
        );
        if (out.captcha_encountered) {
          const retryNote = out.retry_count
            ? ` (${out.retry_count} wait-retries, ${out.total_wait_sec || 0}s total wait)`
            : "";
          console.warn(`[processor] ${step} for ${item.domain}: CAPTCHA was encountered during search${retryNote}`);
          if (out.wait_retry_stopped) {
            console.warn(
              `[processor] ${step} for ${item.domain}: wait+retry stopped early due to step timeout budget`
            );
          }
        }
      }
    } catch (e) {
      console.error(`[processor] ${step} failed for ${item.domain}:`, e.message);
    }

    if (stepSucceeded) completedStepsThisRun.push(step);

    while (state.paused && !state.stopped) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (completedStepsThisRun.length) {
    updateItemProgress(item.id, completedStepsThisRun);
  } else if (state.stopped) {
    const row = db.prepare("SELECT proc_progress, proc_status FROM domain_list_items WHERE id=?").get(item.id);
    const completed = getCompletedStepsForItem(row || item);
    const proc_status = completed.length === ALL_STEPS.length
      ? "done"
      : completed.length > 0
        ? "partial"
        : "pending";
    db.prepare("UPDATE domain_list_items SET proc_status=?, updated_at=datetime('now') WHERE id=?")
      .run(proc_status, item.id);
  }

  if (!state.stopped) {
    try {
      const { added, removed } = syncProspectsForListItem(item.id, resultsMode);
      if (added || removed) {
        const parts = [];
        if (removed) parts.push(`${removed} removed`);
        if (added) parts.push(`${added} added`);
        console.log(`[processor] Prospects synced for ${item.domain} (${resultsMode}): ${parts.join(", ")}`);
      }
    } catch (e) {
      console.error(`[processor] prospect sync failed for ${item.domain}:`, e.message);
    }

    try {
      const remoteSync = require("./remote-db-sync");
      remoteSync.scheduleSyncAfterWrite();
    } catch {
      // optional
    }
  }
}

async function runLoop() {
  try {
    const chrome = await ensureChrome();
    console.log(`[processor] Chrome ready on port ${chrome.port}${chrome.launched ? " (launched)" : ""}`);
    await new Promise((r) => setTimeout(r, 2500));
  } catch (e) {
    console.warn("[processor] Chrome launch warning:", e.message);
  }

  const requestedSteps = state.steps || ALL_STEPS;
  for (let i = state.currentIndex; i < state.itemIds.length; i++) {
    if (state.stopped) break;
    while (state.paused && !state.stopped) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (state.stopped) break;

    state.currentIndex = i;
    db.prepare("UPDATE processing_jobs SET current_index=?, updated_at=datetime('now') WHERE id=?").run(i, state.jobId);

    const item = db.prepare("SELECT * FROM domain_list_items WHERE id=?").get(state.itemIds[i]);
    if (!item) continue;

    const stepsForItem = resolveStepsForItem(item, requestedSteps, state.stepMode);
    await processOneItem(item, stepsForItem, state.resultsMode, state.googleStrategy, state.googleWaitMin);
  }

  const finalStatus = state.stopped ? "stopped" : "completed";
  state.status = finalStatus;
  db.prepare("UPDATE processing_jobs SET status=?, updated_at=datetime('now') WHERE id=?").run(finalStatus, state.jobId);
  try {
    const remoteSync = require("./remote-db-sync");
    remoteSync.scheduleSyncAfterWrite();
    remoteSync.syncNow().catch((err) => {
      console.error("[processor] remote sync after job:", err.message);
    });
  } catch {
    // optional
  }
  // Keep completed state for UI polling; reset only stop flags.
  if (state.stopped) {
    state = { ...state, jobId: null, paused: false, stopped: false };
  }
}

function startProcessing({
  listId,
  mode = "all",
  selectedIds = [],
  steps = null,
  stepMode = "selected",
  resultsMode = "overwrite",
  googleStrategy = "selenium",
  googleWaitMin = 10,
}) {
  if (state.status === "running" || state.status === "paused") {
    return { ok: false, error: "Job already running" };
  }

  const normalizedResultsMode = RESULTS_MODES.includes(resultsMode) ? resultsMode : "overwrite";
  const normalizedStepMode = STEP_MODES.includes(stepMode) ? stepMode : "selected";
  const normalizedSteps = normalizeSteps(steps);
  if (!normalizedSteps.length) {
    return { ok: false, error: "Select at least one processing source" };
  }
  const normalizedGoogleStrategy = ["selenium", "selenium_apify_fallback", "selenium_wait_retry"].includes(googleStrategy)
    ? googleStrategy
    : "selenium";
  const normalizedGoogleWaitMin = [5, 10, 20].includes(Number(googleWaitMin)) ? Number(googleWaitMin) : 10;

  let itemIds;
  if (mode === "selected" && selectedIds.length) {
    itemIds = selectedIds.map(Number);
  } else {
    itemIds = db.prepare("SELECT id FROM domain_list_items WHERE list_id=? ORDER BY position").all(listId).map((r) => r.id);
  }
  if (!itemIds.length) return { ok: false, error: "No items to process" };

  if (normalizedStepMode === "remaining") {
    const hasWork = itemIds.some((id) => {
      const item = db.prepare("SELECT * FROM domain_list_items WHERE id=?").get(id);
      return item && resolveStepsForItem(item, normalizedSteps, "remaining").length > 0;
    });
    if (!hasWork) {
      return { ok: false, error: "No remaining steps for the selected domains" };
    }
  }

  const info = db.prepare(`
    INSERT INTO processing_jobs (list_id, status, mode, selected_ids, current_index, steps, results_mode, step_mode)
    VALUES (?, 'running', ?, ?, 0, ?, ?, ?)
  `).run(
    listId,
    mode,
    JSON.stringify(itemIds),
    JSON.stringify(normalizedSteps),
    normalizedResultsMode,
    normalizedStepMode
  );

  state = {
    jobId: info.lastInsertRowid,
    listId,
    status: "running",
    paused: false,
    stopped: false,
    itemIds,
    currentIndex: 0,
    currentStep: normalizedSteps[0],
    steps: normalizedSteps,
    stepMode: normalizedStepMode,
    resultsMode: normalizedResultsMode,
    googleStrategy: normalizedGoogleStrategy,
    googleWaitMin: normalizedGoogleWaitMin,
  };

  if (!process.env.ZFBOT_EMAIL || !process.env.ZFBOT_PASSWORD) {
    console.warn("[processor] ZFBot credentials missing. Set ZFBOT_EMAIL and ZFBOT_PASSWORD in project .env");
  }
  if (normalizedGoogleStrategy === "selenium_apify_fallback" && !process.env.APIFY_PROXY_PASSWORD) {
    console.warn("[processor] APIFY_PROXY_PASSWORD missing. Selenium+Apify fallback will not work without it.");
  }
  if (normalizedGoogleStrategy === "selenium_wait_retry") {
    console.log(`[processor] Google wait+retry enabled (${normalizedGoogleWaitMin} min on CAPTCHA)`);
  }
  const stepNames = normalizedSteps.map((s) => STEP_LABELS[s] || s).join(", ");
  console.log(
    `[processor] Job started: ${itemIds.length} domains, steps=[${stepNames}], mode=${normalizedStepMode}, results=${normalizedResultsMode}`
  );

  runLoop().catch((e) => {
    console.error("[processor] loop error:", e);
    state.status = "error";
    db.prepare("UPDATE processing_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?")
      .run(e.message, state.jobId);
  });

  return {
    ok: true,
    jobId: state.jobId,
    total: itemIds.length,
    steps: normalizedSteps,
    stepMode: normalizedStepMode,
    resultsMode: normalizedResultsMode,
    googleStrategy: normalizedGoogleStrategy,
    googleWaitMin: normalizedGoogleWaitMin,
  };
}

function pauseProcessing() {
  if (state.status !== "running") return { ok: false, error: "Not running" };
  state.paused = true;
  state.status = "paused";
  if (state.jobId) db.prepare("UPDATE processing_jobs SET status='paused', updated_at=datetime('now') WHERE id=?").run(state.jobId);
  return { ok: true };
}

function resumeProcessing() {
  if (state.status !== "paused") return { ok: false, error: "Not paused" };
  state.paused = false;
  state.status = "running";
  if (state.jobId) db.prepare("UPDATE processing_jobs SET status='running', updated_at=datetime('now') WHERE id=?").run(state.jobId);
  return { ok: true };
}

function stopProcessing() {
  state.stopped = true;
  state.paused = false;
  state.status = "stopped";
  if (state.jobId) db.prepare("UPDATE processing_jobs SET status='stopped', updated_at=datetime('now') WHERE id=?").run(state.jobId);
  return { ok: true };
}

module.exports = {
  startProcessing,
  pauseProcessing,
  resumeProcessing,
  stopProcessing,
  getState,
  runPython,
  runPythonWithProgress,
  deriveWords,
  brandSearchQuery,
  buildGoogleSearchQueries,
  ALL_STEPS,
  STEP_LABELS,
  normalizeSteps,
  getCompletedStepsForItem,
  resolveStepsForItem,
};
