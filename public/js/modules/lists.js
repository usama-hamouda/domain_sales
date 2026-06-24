const { api, toast, today, esc } = window.AppAPI;
const { parseExpiredDomainsHTML, parseCSV, rowsToItems } = window.ParseDomains;

const DEFAULT_COLS = [
  { key: "domain", label: "Domain", sortable: true },
  { key: "google_partial", label: "G-Part", sortable: true, numeric: true },
  { key: "google_exact", label: "G-Exact", sortable: true, numeric: true },
  { key: "linkedin_exact", label: "LI", sortable: true, numeric: true },
  { key: "instagram_exact", label: "IG", sortable: true, numeric: true },
  { key: "zfbot_count", label: "ZFBot", sortable: true, numeric: true },
  { key: "crunchbase_exact", label: "CB", sortable: true, numeric: true },
  { key: "final_prospects_count", label: "Final", sortable: true, numeric: true },
  { key: "proc_status", label: "Status", sortable: true },
  { key: "length", label: "Len", sortable: true, numeric: true },
  { key: "backlinks", label: "BL", sortable: true, numeric: true },
  { key: "archive", label: "WBY", sortable: true, numeric: true },
  { key: "whois", label: "ABY", sortable: true, numeric: true },
  { key: "regCount", label: "Reg", sortable: true },
  { key: "related", label: "RDT", sortable: true, numeric: true },
];

const PROCESSING_COL_KEYS = [
  "google_partial",
  "google_exact",
  "linkedin_exact",
  "instagram_exact",
  "zfbot_count",
  "crunchbase_exact",
  "final_prospects_count",
  "proc_status",
];

const PROC_SOURCE_OPTIONS = [
  { id: "srcGoogle", step: "google_serp", label: "Google" },
  { id: "srcLinkedin", step: "linkedin", label: "LI" },
  { id: "srcInstagram", step: "instagram", label: "IG" },
  { id: "srcZfbot", step: "zfbot", label: "ZFBot" },
  { id: "srcCrunchbase", step: "crunchbase", label: "CB" },
];

const LS_PROC_SOURCES = "domainSales.procSources";

function orderListColumns(cols) {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const ordered = [];
  const domain = byKey.get("domain");
  if (domain) ordered.push(domain);

  for (const key of PROCESSING_COL_KEYS) {
    const col = byKey.get(key) || DEFAULT_COLS.find((c) => c.key === key);
    if (col && !ordered.some((c) => c.key === col.key)) ordered.push(col);
  }

  for (const col of cols) {
    if (col.key === "domain" || PROCESSING_COL_KEYS.includes(col.key)) continue;
    if (!ordered.some((c) => c.key === col.key)) ordered.push(col);
  }
  return ordered;
}

let currentListId = null;
const LS_LAST_LIST = "domainSales.lastListId";
let currentList = null;
let table = null;
let selectedIds = [];
let procPoll = null;
let lastProcStatus = "idle";
let lastProcIndex = -1;
let lastProcStep = null;
let activeResultItemId = null;
let modalFinalByResultId = new Map();

function renderFinalToggleButton(inFinal, resultId) {
  return `<button type="button" class="icon-btn final-toggle-btn ${inFinal ? "final-added" : ""}" data-toggle-final-result="${resultId}" data-in-final="${inFinal ? "1" : "0"}" title="${inFinal ? "Remove from final list" : "Add to final list"}">★</button>`;
}

export function cleanupListsModule() {
  if (procPoll) {
    clearInterval(procPoll);
    procPoll = null;
  }
}

export async function initListsModule(root) {
  // Reset view state after navigation between modules.
  table = null;
  selectedIds = [];
  if (procPoll) {
    clearInterval(procPoll);
    procPoll = null;
  }

  root.innerHTML = `
    <div class="app-body">
      <aside class="sidebar" id="listsSidebar">
        <div class="sidebar-header">
          <span>Domain Lists</span>
          <button id="btnNewList" title="Import new">+</button>
        </div>
        <div class="sidebar-list" id="listsSidebarList"></div>
      </aside>
      <div class="main-panel">
        <div class="import-area" id="importArea">
          <textarea id="htmlInput" placeholder="Paste ExpiredDomains.net HTML here…"></textarea>
          <div class="toolbar" style="border:none;padding:8px 0 0">
            <button class="primary" id="btnParseHtml">Parse HTML</button>
            <label class="import-label">Import CSV<input type="file" id="csvFile" accept=".csv"></label>
            <input type="text" id="listNameInput" placeholder="List name (default: today's date)" style="flex:1;max-width:280px">
          </div>
        </div>
        <div class="toolbar">
          <span class="toolbar-title" id="listTitle">Select or import a list</span>
          <label class="import-label">Import CSV<input type="file" id="csvFileToolbar" accept=".csv,.txt"></label>
          <button id="btnNewImport" title="Show import panel">+ Import</button>
          <button id="btnSelectAll">Select All</button>
          <button id="btnDeselectAll">Deselect All</button>
          <button class="success" id="btnSaveCampaign">→ Campaign</button>
          <span style="width:1px;height:20px;background:var(--border)"></span>
          <label class="proc-results-mode" title="How to handle existing processing results">
            Results
            <select id="procResultsMode">
              <option value="overwrite">Overwrite</option>
              <option value="merge">Merge / update</option>
            </select>
          </label>
          <label class="proc-results-mode" title="Google search strategy">
            Google Strategy
            <select id="googleSearchStrategy">
              <option value="selenium">Selenium only</option>
              <option value="selenium_apify_fallback">Selenium + Apify on CAPTCHA</option>
              <option value="selenium_wait_retry">Selenium wait+retry on CAPTCHA</option>
            </select>
          </label>
          <label class="proc-results-mode" title="Wait time before Selenium retry when CAPTCHA appears">
            CAPTCHA Wait
            <select id="googleCaptchaWaitMin">
              <option value="5">5 min</option>
              <option value="10" selected>10 min</option>
              <option value="20">20 min</option>
            </select>
          </label>
          <span class="proc-sources" title="Choose which sources to run (uncheck to skip and save traffic)">
            Sources
            ${PROC_SOURCE_OPTIONS.map((s) => `
              <label><input type="checkbox" id="${s.id}" data-proc-step="${s.step}" checked> ${s.label}</label>
            `).join("")}
            <label class="proc-sources-all" title="Toggle all sources"><input type="checkbox" id="srcAll" checked> All</label>
          </span>
          <label class="proc-results-mode" title="Only run sources not yet completed for each domain">
            <input type="checkbox" id="procRemainingOnly"> Remaining only
          </label>
          <button class="primary" id="btnProcStart">▶ Process</button>
          <button id="btnProcSelected">▶ Selected</button>
          <button id="btnProcRemaining" title="Run only missing sources for all domains">▶ Remaining</button>
          <button id="btnProcPause">⏸ Pause</button>
          <button class="warn" id="btnProcStop">⏹ Stop</button>
        </div>
        <div class="proc-bar"><div class="proc-bar-fill" id="procBarFill"></div></div>
        <div class="proc-status" id="procStatus" style="font-size:12px;color:var(--text-dim);padding:2px 8px"></div>
        <div class="stats-row" id="listStats"></div>
        <div id="tableHost" class="flex-table-host"></div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="campaignModal">
      <div class="modal">
        <h3>Add to Campaign</h3>
        <div class="field"><label>Campaign</label>
          <select id="campaignSelect"><option value="new">+ New Campaign</option></select>
        </div>
        <div class="field hidden" id="newCampField"><label>New campaign name</label>
          <input type="text" id="newCampName">
        </div>
        <div class="modal-actions">
          <button id="btnCampCancel">Cancel</button>
          <button class="primary" id="btnCampConfirm">Add</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="renameModal">
      <div class="modal">
        <h3>Rename List</h3>
        <div class="field"><label>Name</label><input type="text" id="renameInput"></div>
        <div class="modal-actions">
          <button id="btnRenameCancel">Cancel</button>
          <button class="primary" id="btnRenameConfirm">Save</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="resultModal">
      <div class="modal result-modal">
        <h3 id="resultModalTitle">Processing Results</h3>
        <div id="resultModalBody" class="result-modal-body"></div>
        <div class="modal-actions">
          <button id="btnResultManageFinal" class="success">Manage Final List</button>
          <button id="btnResultClose">Close</button>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  restoreProcSourcePrefs();
  const lists = await loadSidebar();
  startProcPoll();
  if (currentListId) {
    await loadList(currentListId);
  } else if (lists.length) {
    const saved = Number(localStorage.getItem(LS_LAST_LIST));
    const pick = lists.find((l) => l.id === saved)?.id ?? lists[0].id;
    await loadList(pick);
  }
}

function bindEvents() {
  document.getElementById("btnParseHtml").onclick = importFromHtml;
  document.getElementById("csvFile").onchange = importFromCsv;
  document.getElementById("csvFileToolbar").onchange = importFromCsv;
  document.getElementById("btnNewList").onclick = showImportPanel;
  document.getElementById("btnNewImport").onclick = showImportPanel;
  document.getElementById("btnSelectAll").onclick = () => selectAll(true);
  document.getElementById("btnDeselectAll").onclick = () => selectAll(false);
  document.getElementById("btnSaveCampaign").onclick = openCampaignModal;
  document.getElementById("btnCampCancel").onclick = () => hideModal("campaignModal");
  document.getElementById("btnCampConfirm").onclick = confirmCampaign;
  document.getElementById("campaignSelect").onchange = (e) => {
    document.getElementById("newCampField").classList.toggle("hidden", e.target.value !== "new");
  };
  document.getElementById("btnProcStart").onclick = () => startProcessing("all", "selected");
  document.getElementById("btnProcSelected").onclick = () => startProcessing("selected", "selected");
  document.getElementById("btnProcRemaining").onclick = () => {
    const mode = selectedIds.length ? "selected" : "all";
    startProcessing(mode, "remaining");
  };
  document.getElementById("btnProcPause").onclick = () => api("/api/processing/pause", { method: "POST" }).then(() => toast("Paused"));
  document.getElementById("btnProcStop").onclick = () => api("/api/processing/stop", { method: "POST" }).then(() => toast("Stopped"));
  document.getElementById("btnRenameCancel").onclick = () => hideModal("renameModal");
  document.getElementById("btnRenameConfirm").onclick = confirmRename;
  document.getElementById("btnResultClose").onclick = () => hideModal("resultModal");
  document.getElementById("resultModal").onclick = (e) => {
    if (e.target.id === "resultModal") hideModal("resultModal");
  };
  document.getElementById("resultModalBody")?.addEventListener("click", onResultModalClick);
  bindProcSourceEvents();
}

function bindProcSourceEvents() {
  const allEl = document.getElementById("srcAll");
  if (!allEl) return;

  const syncAllCheckbox = () => {
    const boxes = PROC_SOURCE_OPTIONS.map((s) => document.getElementById(s.id)).filter(Boolean);
    const checked = boxes.filter((el) => el.checked).length;
    allEl.checked = checked === boxes.length;
    allEl.indeterminate = checked > 0 && checked < boxes.length;
  };

  allEl.onchange = () => {
    const on = allEl.checked;
    for (const s of PROC_SOURCE_OPTIONS) {
      const el = document.getElementById(s.id);
      if (el) el.checked = on;
    }
    saveProcSourcePrefs();
    syncAllCheckbox();
  };

  for (const s of PROC_SOURCE_OPTIONS) {
    const el = document.getElementById(s.id);
    if (!el) continue;
    el.onchange = () => {
      saveProcSourcePrefs();
      syncAllCheckbox();
    };
  }
  syncAllCheckbox();
}

function restoreProcSourcePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PROC_SOURCES) || "null");
    if (!Array.isArray(saved) || !saved.length) return;
    for (const s of PROC_SOURCE_OPTIONS) {
      const el = document.getElementById(s.id);
      if (el) el.checked = saved.includes(s.step);
    }
  } catch {
    // ignore invalid prefs
  }
}

function saveProcSourcePrefs() {
  const steps = getSelectedProcSteps();
  if (steps.length) localStorage.setItem(LS_PROC_SOURCES, JSON.stringify(steps));
}

function getSelectedProcSteps() {
  return PROC_SOURCE_OPTIONS
    .filter((s) => document.getElementById(s.id)?.checked)
    .map((s) => s.step);
}

function formatProcSteps(steps, labels = {}) {
  return (steps || []).map((s) => labels[s] || s).join(", ");
}

async function onResultModalClick(e) {
  const btn = e.target.closest("[data-toggle-final-result]");
  if (!btn || !currentListId || !activeResultItemId) return;
  e.preventDefault();
  const resultId = Number(btn.dataset.toggleFinalResult);
  if (!resultId) return;
  const bodyEl = document.getElementById("resultModalBody");
  const scrollTop = bodyEl?.scrollTop ?? 0;
  btn.disabled = true;
  try {
    const out = await api(`/api/lists/${currentListId}/items/${activeResultItemId}/final-prospects/toggle`, {
      method: "POST",
      body: { processingResultId: resultId },
    });
    if (out.inFinal) {
      toast("Added to final prospects");
      bumpFinalProspectCount(activeResultItemId, 1);
      if (out.warnings?.length) {
        toast(out.warnings.join(" "), 8000);
      }
    } else {
      toast("Removed from final prospects");
      bumpFinalProspectCount(activeResultItemId, -1);
    }
    updateResultModalFinalRow(resultId, out.inFinal);
    updateResultModalFinalStat();
    if (bodyEl) bodyEl.scrollTop = scrollTop;
  } catch (err) {
    toast(err.message || "Failed to update final list");
    btn.disabled = false;
  }
}

function updateResultModalFinalRow(resultId, inFinal) {
  const btn = document.querySelector(`[data-toggle-final-result="${resultId}"]`);
  const tr = btn?.closest("tr");
  if (!tr) return;
  tr.classList.toggle("in-final-row", inFinal);
  const td = btn.parentElement;
  if (td) td.innerHTML = renderFinalToggleButton(inFinal, resultId);
}

function updateResultModalFinalStat() {
  const count = document.querySelectorAll("#resultModalBody tr.in-final-row").length;
  const chips = document.querySelectorAll("#resultModalBody .stat-chip");
  for (const chip of chips) {
    if (chip.textContent?.startsWith("Final Prospects:")) {
      const span = chip.querySelector("span");
      if (span) span.textContent = String(count);
    }
  }
}

async function loadSidebar() {
  const lists = await api("/api/lists");
  const el = document.getElementById("listsSidebarList");
  el.innerHTML = lists.map((l) => `
    <div class="sidebar-item ${l.id === currentListId ? "active" : ""}" data-id="${l.id}">
      <div>${esc(l.name)}</div>
      <div class="meta">${l.list_date} · ${l.item_count} domains</div>
    </div>
  `).join("") || `<div style="padding:12px;color:var(--text-dim);font-size:12px">No lists yet</div>`;

  el.querySelectorAll(".sidebar-item").forEach((item) => {
    item.onclick = () => loadList(Number(item.dataset.id));
    item.oncontextmenu = (e) => {
      e.preventDefault();
      currentListId = Number(item.dataset.id);
      document.getElementById("renameInput").value = lists.find((x) => x.id === currentListId)?.name || "";
      showModal("renameModal");
    };
  });
  return lists;
}

async function loadList(id) {
  currentListId = id;
  localStorage.setItem(LS_LAST_LIST, String(id));
  currentList = await api(`/api/lists/${id}`);
  document.getElementById("listTitle").textContent = currentList.name;
  document.getElementById("importArea").classList.add("hidden");

  const baseCols = (currentList.col_order?.length ? currentList.col_order : DEFAULT_COLS)
    .map((c) => (typeof c === "string" ? DEFAULT_COLS.find((d) => d.key === c) || { key: c, label: c } : c));
  const mandatoryMetricCols = PROCESSING_COL_KEYS.filter((k) => k !== "domain");
  const missingCols = mandatoryMetricCols
    .filter((key) => !baseCols.some((c) => c.key === key))
    .map((key) => DEFAULT_COLS.find((c) => c.key === key))
    .filter(Boolean);
  const cols = orderListColumns([...baseCols, ...missingCols]).map((col) => {
    if (col.key === "domain") {
      return {
        ...col,
        render: (row) => `
          <div class="domain-cell">
            <span>${esc(row.domain || row.row_data?.domain || "-")}</span>
            <button class="domain-results-btn" data-action="view-results" data-item-id="${row.id}" title="View processing details">
              Results
            </button>
          </div>
        `,
      };
    }
    if (col.key === "final_prospects_count") {
      return {
        ...col,
        render: (row) => {
          const count = Number(row.final_prospects_count) || 0;
          if (!count) return `<span class="num">0</span>`;
          return `<button class="domain-results-btn final-count-btn" data-action="view-final" data-item-id="${row.id}" title="View final prospects">${count}</button>`;
        },
      };
    }
    return col;
  });

  const rows = currentList.items.map((item) => ({
    ...item.row_data,
    ...item,
    domain: item.domain || item.row_data?.domain,
    id: item.id,
    selected: item.selected,
    final_prospects_count: Number(item.final_prospects_count) || 0,
  }));
  selectedIds = rows.filter((r) => !!r.selected).map((r) => r.id);

  const host = document.getElementById("tableHost");
  if (!table || table.container !== host) {
    table = new DataTable(host, {
      columns: cols,
      rows,
      stickyKey: "domain",
      onSelectionChange: (ids) => {
        selectedIds = ids;
        updateStats(rows);
      },
    });
    table.selected = new Set(selectedIds);
    table._render();
  } else {
    table.columns = cols;
    table.setData(rows);
    table.selected = new Set(selectedIds);
    table._render();
  }

  updateStats(rows);
  bindResultButtons();
  await loadSidebar();
}

function updateStats(rows) {
  const done = rows.filter((r) => r.proc_status === "done").length;
  const partial = rows.filter((r) => r.proc_status === "partial").length;
  const withFinal = rows.filter((r) => (Number(r.final_prospects_count) || 0) > 0).length;
  const finalTotal = rows.reduce((sum, r) => sum + (Number(r.final_prospects_count) || 0), 0);
  document.getElementById("listStats").innerHTML = `
    <div class="stat-chip">Total: <span>${rows.length}</span></div>
    <div class="stat-chip">Done: <span>${done}</span></div>
    <div class="stat-chip">Partial: <span>${partial}</span></div>
    <div class="stat-chip">With Final: <span>${withFinal}</span></div>
    <div class="stat-chip">Final Prospects: <span>${finalTotal}</span></div>
    <div class="stat-chip">Selected: <span>${selectedIds.length}</span></div>
  `;
}

async function importFromHtml() {
  try {
    const html = document.getElementById("htmlInput").value;
    const parsed = parseExpiredDomainsHTML(html);
    if (!parsed.length) { toast("No domains parsed"); return; }
    await saveList(parsed);
  } catch (e) {
    toast(e.message || "HTML import failed");
  }
}

async function importFromCsv(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    toast(`Reading ${file.name}…`);
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) { toast("No rows in CSV"); return; }
    const items = rowsToItems(rows);
    if (!items.length) {
      toast("No valid domains found — check CSV format");
      return;
    }
    await saveList(items.map((i) => ({ ...i.row_data, domain: i.domain })));
  } catch (err) {
    console.error("CSV import:", err);
    toast(err.message || "CSV import failed");
  }
  e.target.value = "";
}

function showImportPanel() {
  document.getElementById("importArea").classList.remove("hidden");
  document.getElementById("listTitle").textContent = "Import new list";
}

function bindResultButtons() {
  const host = document.getElementById("tableHost");
  if (!host) return;
  host.onclick = async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || !currentListId) return;
    const itemId = Number(btn.dataset.itemId);
    if (!itemId) return;
    e.preventDefault();
    if (btn.dataset.action === "view-results") {
      await openResultsModal(itemId);
      return;
    }
    if (btn.dataset.action === "view-final") {
      const row = currentList?.items?.find((i) => i.id === itemId);
      const domain = row?.domain || row?.row_data?.domain || "Domain";
      window.AppRouter.navigate("final-prospects", { listId: currentListId, listItemId: itemId, domain });
    }
  };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bumpFinalProspectCount(itemId, delta) {
  const item = currentList?.items?.find((i) => i.id === itemId);
  if (!item || !delta) return;
  item.final_prospects_count = Math.max(0, (Number(item.final_prospects_count) || 0) + delta);
  if (!table) return;
  const row = table.rows.find((r) => r.id === itemId);
  if (row) row.final_prospects_count = item.final_prospects_count;
  updateStats(table.rows);
  table._render();
}

async function openResultsModal(itemId) {
  if (!currentListId) return;
  activeResultItemId = itemId;
  const bodyEl = document.getElementById("resultModalBody");
  const titleEl = document.getElementById("resultModalTitle");
  const row = currentList?.items?.find((i) => i.id === itemId);
  const domain = row?.domain || row?.row_data?.domain || "Domain";
  titleEl.textContent = `Processing Results: ${domain}`;
  bodyEl.innerHTML = `<div style="padding:8px 0;color:var(--text-dim)">Loading results…</div>`;
  showModal("resultModal");

  try {
    const [results, finalList] = await Promise.all([
      api(`/api/lists/${currentListId}/items/${itemId}/results`),
      api(`/api/lists/${currentListId}/items/${itemId}/final-prospects`).catch(() => []),
    ]);
    if (activeResultItemId !== itemId) return;

    const finalByResultId = new Map(
      (finalList || []).filter((f) => f.processing_result_id).map((f) => [f.processing_result_id, f])
    );
    modalFinalByResultId = finalByResultId;
    const finalResultIds = new Set(finalByResultId.keys());
    const finalCount = (finalList || []).length;

    document.getElementById("btnResultManageFinal").onclick = () => {
      hideModal("resultModal");
      window.AppRouter.navigate("final-prospects", { listId: currentListId, listItemId: itemId, domain });
    };

    const byStep = {};
    const byMatchType = {};
    for (const r of results) {
      const step = r.step || "unknown";
      const match = r.match_type || "unknown";
      byStep[step] = (byStep[step] || 0) + 1;
      byMatchType[match] = (byMatchType[match] || 0) + 1;
    }

    const metricSource = { ...(row?.row_data || {}), ...(row || {}) };
    const summaryMetrics = [
      ["G-Part", toNumber(metricSource.google_partial)],
      ["G-Exact", toNumber(metricSource.google_exact)],
      ["LinkedIn", toNumber(metricSource.linkedin_exact)],
      ["Instagram", toNumber(metricSource.instagram_exact)],
      ["ZFBot", toNumber(metricSource.zfbot_count)],
      ["Crunchbase", toNumber(metricSource.crunchbase_exact)],
    ];
    const statMetrics = [
      ["Total Results", results.length],
      ["Unique Steps", Object.keys(byStep).length],
      ["Unique Match Types", Object.keys(byMatchType).length],
      ["Status", esc(metricSource.proc_status || "-")],
      ["Final Prospects", finalCount],
    ];

    bodyEl.innerHTML = `
      <div class="result-stats-grid">
        ${summaryMetrics.map(([label, value]) => `
          <div class="stat-chip">${label}: <span>${value}</span></div>
        `).join("")}
      </div>
      <div class="result-stats-grid">
        ${statMetrics.map(([label, value]) => `
          <div class="stat-chip">${label}: <span>${value}</span></div>
        `).join("")}
      </div>
      <div class="result-section">
        <h4>Statistics by Step</h4>
        <table class="data-table result-table">
          <thead><tr><th>Step</th><th>Count</th></tr></thead>
          <tbody>
            ${Object.entries(byStep).map(([step, count]) => `
              <tr><td>${esc(step)}</td><td class="num">${count}</td></tr>
            `).join("") || `<tr><td colspan="2">No data</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="result-section">
        <h4>Statistics by Match Type</h4>
        <table class="data-table result-table">
          <thead><tr><th>Match Type</th><th>Count</th></tr></thead>
          <tbody>
            ${Object.entries(byMatchType).map(([match, count]) => `
              <tr><td>${esc(match)}</td><td class="num">${count}</td></tr>
            `).join("") || `<tr><td colspan="2">No data</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="result-section">
        <h4>Detailed Results</h4>
        <table class="data-table result-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Final</th>
              <th>Match</th>
              <th>Result Domain</th>
              <th>Title</th>
              <th>URL</th>
              <th>Info</th>
            </tr>
          </thead>
          <tbody>
            ${results.map((r) => {
              const inFinal = finalResultIds.has(r.id);
              return `
              <tr class="${inFinal ? "in-final-row" : ""}">
                <td>${esc(r.step || "-")}</td>
                <td>${renderFinalToggleButton(inFinal, r.id)}</td>
                <td>${esc(r.match_type || "-")}</td>
                <td>${esc(r.result_domain || "-")}</td>
                <td>${esc(r.title || "-")}</td>
                <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : "-"}</td>
                <td>${esc(r.extra ? JSON.stringify(r.extra) : "-")}</td>
              </tr>
            `;
            }).join("") || `<tr><td colspan="7">No processing results yet for this domain.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    bodyEl.innerHTML = `<div style="padding:8px 0;color:var(--warn)">Failed to load results: ${esc(e.message || "Unknown error")}</div>`;
  }
}

async function saveList(domainRows) {
  const normalized = domainRows
    .map((r) => {
      const domain = (r.domain || r.Domain || r.domainname || Object.values(r)[0] || "").trim();
      return { domain, row_data: { ...r, domain } };
    })
    .filter((r) => r.domain && r.domain.includes("."));

  if (!normalized.length) {
    toast("No valid domains to save");
    return;
  }

  const name = document.getElementById("listNameInput").value.trim() || `List ${today()}`;
  const colKeys = Object.keys(normalized[0].row_data || {});
  const processingMetricKeys = new Set(PROCESSING_COL_KEYS);
  const col_order = orderListColumns(
    DEFAULT_COLS.filter((c) => colKeys.includes(c.key) || processingMetricKeys.has(c.key))
      .concat(colKeys.filter((k) => !DEFAULT_COLS.some((d) => d.key === k)).map((k) => ({ key: k, label: k })))
  );

  const list = await api("/api/lists", {
    method: "POST",
    body: {
      name,
      list_date: today(),
      col_order,
      items: normalized.map((r) => ({ domain: r.domain, row_data: r.row_data })),
    },
  });
  toast(`Saved ${normalized.length} domains`);
  document.getElementById("htmlInput").value = "";
  document.getElementById("listNameInput").value = "";
  document.getElementById("importArea").classList.add("hidden");
  await loadList(list.id);
}

async function selectAll(val) {
  if (!currentListId) return;
  await api(`/api/lists/${currentListId}/items/select-all`, { method: "POST", body: { selected: val } });
  await loadList(currentListId);
}

async function openCampaignModal() {
  if (!selectedIds.length) { toast("Select domains first"); return; }
  const camps = await api("/api/campaigns");
  const sel = document.getElementById("campaignSelect");
  sel.innerHTML = `<option value="new">+ New Campaign</option>` +
    camps.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  showModal("campaignModal");
}

async function confirmCampaign() {
  const campVal = document.getElementById("campaignSelect").value;
  const createNew = campVal === "new";
  const newName = document.getElementById("newCampName").value.trim();
  await api(`/api/campaigns/${createNew ? 0 : campVal}/domains`, {
    method: "POST",
    body: {
      itemIds: selectedIds,
      createNew,
      newCampaignName: newName || `Campaign ${today()}`,
    },
  });
  hideModal("campaignModal");
  toast(`Added ${selectedIds.length} domains to campaign`);
}

async function confirmRename() {
  const name = document.getElementById("renameInput").value.trim();
  if (!name || !currentListId) return;
  await api(`/api/lists/${currentListId}`, { method: "PATCH", body: { name } });
  hideModal("renameModal");
  await loadList(currentListId);
}

async function startProcessing(mode, stepMode = "selected") {
  if (!currentListId) { toast("Load a list first"); return; }

  const remainingOnly = document.getElementById("procRemainingOnly")?.checked;
  const effectiveStepMode = remainingOnly || stepMode === "remaining" ? "remaining" : "selected";

  const steps = getSelectedProcSteps();
  if (!steps.length) { toast("Select at least one source"); return; }

  let resultsMode = document.getElementById("procResultsMode")?.value || "overwrite";
  if (effectiveStepMode === "remaining") {
    if (resultsMode === "overwrite") {
      const sel = document.getElementById("procResultsMode");
      if (sel) sel.value = "merge";
      resultsMode = "merge";
    }
  } else if (resultsMode === "overwrite") {
    // overwrite only affects selected sources — safe to continue
  }

  const googleStrategy = document.getElementById("googleSearchStrategy")?.value || "selenium";
  const googleWaitMin = Number(document.getElementById("googleCaptchaWaitMin")?.value || 10);
  const body = {
    listId: currentListId,
    mode,
    steps,
    stepMode: effectiveStepMode,
    resultsMode,
    googleStrategy,
    googleWaitMin,
  };
  if (mode === "selected") {
    if (!selectedIds.length) { toast("Nothing selected"); return; }
    body.selectedIds = selectedIds;
  }
  const r = await api("/api/processing/start", { method: "POST", body });
  if (r.ok) {
    lastProcStatus = "running";
    lastProcIndex = -1;
    lastProcStep = null;
    const modeLabel = resultsMode === "merge" ? "merging with existing results" : "overwriting selected sources";
    const strategyLabel = googleStrategy === "selenium_apify_fallback"
      ? "Selenium + Apify fallback"
      : googleStrategy === "selenium_wait_retry"
        ? `Selenium wait+retry (${googleWaitMin}m)`
        : "Selenium only";
    const stepLabels = PROC_SOURCE_OPTIONS.reduce((acc, s) => {
      acc[s.step] = s.label;
      return acc;
    }, {});
    const sourcesLabel = effectiveStepMode === "remaining"
      ? `remaining from [${formatProcSteps(steps, stepLabels)}]`
      : formatProcSteps(steps, stepLabels);
    toast(`Processing ${r.total} domains (${sourcesLabel}, ${modeLabel}, ${strategyLabel})…`);
  } else toast(r.error || "Failed");
}

function startProcPoll() {
  if (procPoll) clearInterval(procPoll);
  procPoll = setInterval(async () => {
    try {
      if (!document.getElementById("tableHost")) return;

      const st = await api("/api/processing/status");
      const el = document.getElementById("procBarFill");
      const statusEl = document.getElementById("procStatus");
      if (statusEl) {
        const modeLabel = st.resultsMode === "merge" ? "merge" : "overwrite";
        const stepLabels = st.stepLabels || {};
        const activeSteps = (st.steps || []).map((s) => stepLabels[s] || s).join(", ");
        const stepModeLabel = st.stepMode === "remaining" ? "remaining" : "selected";
        statusEl.textContent = st.status !== "idle" && st.status !== "completed"
          ? `${st.status} · ${stepModeLabel} · ${activeSteps} · ${modeLabel} · ${st.currentStep || ""} · ${st.currentIndex + 1}/${st.itemIds?.length || "?"}`
          : st.status === "completed" ? "completed" : "";
      }
      if (st.itemIds?.length) {
        el.style.width = `${((st.currentIndex + 1) / st.itemIds.length) * 100}%`;
      } else if (st.status !== "completed") {
        el.style.width = "0%";
      }

      const onThisList = currentListId && (st.listId === currentListId || !st.listId);
      const indexChanged = st.currentIndex !== lastProcIndex;
      const stepChanged = st.currentStep !== lastProcStep;

      if (onThisList && currentListId && (
        (st.status === "running" && (indexChanged || stepChanged)) ||
        (st.status === "completed" && lastProcStatus !== "completed")
      )) {
        await loadList(currentListId);
      }

      if (indexChanged) lastProcIndex = st.currentIndex;
      if (stepChanged) lastProcStep = st.currentStep;
      lastProcStatus = st.status;
    } catch { /* ignore */ }
  }, 3000);
}

function showModal(id) { document.getElementById(id).classList.remove("hidden"); }
function hideModal(id) {
  document.getElementById(id).classList.add("hidden");
  if (id === "resultModal") activeResultItemId = null;
}
