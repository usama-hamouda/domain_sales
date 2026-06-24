const { db } = require("../db");
const { peekOutbox, deleteOutboxUpTo, outboxCount, clearStuckSuppressFlag } = require("./sync-outbox");
const syncApply = require("./sync-apply");

const DEBOUNCE_MS = Number(process.env.REMOTE_API_SYNC_DEBOUNCE_MS || process.env.REMOTE_DB_SYNC_DEBOUNCE_MS || 4000);
const MAX_DEBOUNCE_MS = Number(process.env.REMOTE_API_SYNC_MAX_DEBOUNCE_MS || 30000);
const BATCH_SIZE = Number(process.env.REMOTE_API_SYNC_BATCH_SIZE || 250);
const PULL_INTERVAL_MS = Number(process.env.REMOTE_API_PULL_INTERVAL_MS || 15000);
const PUSH_INTERVAL_MS = Number(process.env.REMOTE_API_PUSH_INTERVAL_MS || 15000);
const PULL_BATCH_SIZE = Number(process.env.REMOTE_API_PULL_BATCH_SIZE || 400);
const META_LAST_PULL_ID = "remote_api_last_pull_id";

let debounceTimer = null;
let syncing = false;
let pendingSync = false;
let lastSyncAt = null;
let lastError = null;
let lastApplied = 0;
let lastPullAt = null;
let lastPulledId = 0;
let pullTimer = null;
let pushTimer = null;
let pulling = false;
let debounceStartedAt = 0;

function isEnabled() {
  return process.env.REMOTE_API_SYNC_ENABLED === "1"
    && process.env.REMOTE_API_URL
    && (process.env.REMOTE_API_TOKEN || process.env.SYNC_API_TOKEN);
}

function getConfig() {
  const url = (process.env.REMOTE_API_URL || "").replace(/\/$/, "");
  return {
    mode: "api",
    enabled: isEnabled(),
    url: url || null,
    batchSize: BATCH_SIZE,
    pullBatchSize: PULL_BATCH_SIZE,
    pullIntervalMs: PULL_INTERVAL_MS,
    pushIntervalMs: PUSH_INTERVAL_MS,
    debounceMs: DEBOUNCE_MS,
    maxDebounceMs: MAX_DEBOUNCE_MS,
    pendingOutbox: isEnabled() ? outboxCount(db) : 0,
  };
}

function getStatus() {
  return {
    ...getConfig(),
    syncing,
    pendingSync,
    lastSyncAt,
    lastError,
    lastApplied,
    lastPullAt,
    lastPulledId,
    pulling,
    pendingOutbox: isEnabled() ? outboxCount(db) : 0,
  };
}

function getSyncToken() {
  return process.env.REMOTE_API_TOKEN || process.env.SYNC_API_TOKEN;
}

function readLastPulledId() {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key=?").get(META_LAST_PULL_ID);
  const parsed = Number(row?.value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function writeLastPulledId(id) {
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run(META_LAST_PULL_ID, String(id));
}

function buildBatchPayload(rows) {
  return rows.map((row) => ({
    table: row.table_name,
    op: row.op,
    row_pk: row.row_pk,
    row: row.row_json ? JSON.parse(row.row_json) : null,
  }));
}

async function postBatch(batch) {
  const baseUrl = process.env.REMOTE_API_URL.replace(/\/$/, "");
  const token = getSyncToken();
  const res = await fetch(`${baseUrl}/api/sync/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ batch }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Remote sync failed (${res.status}) at ${baseUrl}/api/sync/apply`);
  }
  return body;
}

async function fetchChanges(since) {
  const baseUrl = process.env.REMOTE_API_URL.replace(/\/$/, "");
  const token = getSyncToken();
  const url = `${baseUrl}/api/sync/changes?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(PULL_BATCH_SIZE)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Remote pull failed (${res.status}) at ${url}`);
  }
  return body;
}

async function pushOutboxBatches() {
  let totalApplied = 0;
  for (;;) {
    const rows = peekOutbox(db, BATCH_SIZE);
    if (!rows.length) break;

    const result = await postBatch(buildBatchPayload(rows));
    const applied = Number(result.applied) || rows.length;
    totalApplied += applied;
    deleteOutboxUpTo(db, rows[rows.length - 1].id);

    if (rows.length < BATCH_SIZE) break;
  }
  return totalApplied;
}

async function pushToRemote() {
  if (!isEnabled()) {
    return { ok: false, error: "Remote API sync is not configured", applied: 0 };
  }
  if (syncing) {
    pendingSync = true;
    return { ok: true, queued: true, applied: 0 };
  }

  syncing = true;
  try {
    const totalApplied = await pushOutboxBatches();
    if (totalApplied > 0) {
      console.log(`[remote-api-sync] Pushed ${totalApplied} change(s) → ${process.env.REMOTE_API_URL}`);
    }
    return { ok: true, applied: totalApplied };
  } catch (err) {
    lastError = err.message;
    throw err;
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      setTimeout(() => { syncNow().catch(() => {}); }, 500);
    }
  }
}

async function pullFromRemote() {
  if (!isEnabled() || pulling) return { ok: true, pulled: 0, maxId: lastPulledId };
  pulling = true;
  try {
    let cursor = readLastPulledId();
    let pulled = 0;
    for (;;) {
      const out = await fetchChanges(cursor);
      const items = Array.isArray(out.items) ? out.items : [];
      if (!items.length) break;

      syncApply.applyBatch(db, items);
      pulled += items.length;
      cursor = Number(out.maxId || items[items.length - 1].id || cursor);
      writeLastPulledId(cursor);

      if (items.length < PULL_BATCH_SIZE) break;
    }
    lastPulledId = cursor;
    lastPullAt = new Date().toISOString();
    if (pulled > 0) {
      console.log(`[remote-api-sync] Pulled ${pulled} change(s) from ${process.env.REMOTE_API_URL}`);
    }
    return { ok: true, pulled, maxId: cursor };
  } catch (err) {
    lastError = err.message;
    return { ok: false, error: err.message };
  } finally {
    pulling = false;
  }
}

/**
 * Push local outbox first, then pull remote only when local queue is drained.
 * Prevents remote stale data from overwriting unpushed local writes.
 */
async function syncNow() {
  if (!isEnabled()) {
    return { ok: false, error: "Remote API sync is not configured" };
  }
  if (syncing) {
    pendingSync = true;
    return { ok: true, queued: true };
  }

  syncing = true;
  pendingSync = false;
  lastError = null;
  let totalApplied = 0;
  let pulled = 0;

  try {
    totalApplied = await pushOutboxBatches();
    if (totalApplied > 0) {
      console.log(`[remote-api-sync] Pushed ${totalApplied} change(s) → ${process.env.REMOTE_API_URL}`);
    }

    if (outboxCount(db) === 0) {
      const pullResult = await pullFromRemote();
      pulled = pullResult.pulled || 0;
    } else {
      pendingSync = true;
    }

    lastApplied = totalApplied;
    lastSyncAt = new Date().toISOString();
    return { ok: true, lastSyncAt, applied: totalApplied, pulled };
  } catch (err) {
    lastError = err.message;
    console.error("[remote-api-sync]", err.message);
    return { ok: false, error: err.message, applied: totalApplied };
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      setTimeout(() => { syncNow().catch(() => {}); }, 500);
    }
  }
}

function scheduleSyncAfterWrite() {
  if (!isEnabled()) return;
  pendingSync = true;

  const now = Date.now();
  if (!debounceStartedAt) debounceStartedAt = now;
  const waited = now - debounceStartedAt;

  clearTimeout(debounceTimer);

  // During long processing jobs debounce keeps resetting — force a push periodically.
  if (waited >= MAX_DEBOUNCE_MS) {
    debounceStartedAt = 0;
    syncNow().catch(() => {});
    return;
  }

  debounceTimer = setTimeout(() => {
    debounceStartedAt = 0;
    syncNow().catch(() => {});
  }, DEBOUNCE_MS);
}

async function periodicSync() {
  if (!isEnabled()) return;
  if (syncing) {
    pendingSync = true;
    return;
  }

  try {
    if (outboxCount(db) > 0) {
      await pushToRemote();
    }
    if (outboxCount(db) === 0) {
      await pullFromRemote();
    }
  } catch (err) {
    lastError = err.message;
    console.error("[remote-api-sync]", err.message);
  }
}

function start() {
  if (!isEnabled() || pullTimer) return;
  clearStuckSuppressFlag(db);
  lastPulledId = readLastPulledId();

  setTimeout(() => {
    periodicSync().catch((err) => {
      lastError = err.message;
      console.error("[remote-api-sync]", err.message);
    });
  }, 1200);

  pushTimer = setInterval(() => {
    if (outboxCount(db) === 0) return;
    pushToRemote().catch((err) => {
      lastError = err.message;
      console.error("[remote-api-sync]", err.message);
    });
  }, PUSH_INTERVAL_MS);

  pullTimer = setInterval(() => {
    periodicSync().catch((err) => {
      lastError = err.message;
      console.error("[remote-api-sync]", err.message);
    });
  }, PULL_INTERVAL_MS);
}

module.exports = {
  isEnabled,
  getConfig,
  getStatus,
  syncNow,
  pushToRemote,
  scheduleSyncAfterWrite,
  pullFromRemote,
  start,
};
