const { db } = require("../db");
const { peekOutbox, deleteOutboxUpTo, outboxCount } = require("./sync-outbox");
const syncApply = require("./sync-apply");

const DEBOUNCE_MS = Number(process.env.REMOTE_API_SYNC_DEBOUNCE_MS || process.env.REMOTE_DB_SYNC_DEBOUNCE_MS || 4000);
const BATCH_SIZE = Number(process.env.REMOTE_API_SYNC_BATCH_SIZE || 250);
const PULL_INTERVAL_MS = Number(process.env.REMOTE_API_PULL_INTERVAL_MS || 15000);
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
let pulling = false;

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
    debounceMs: DEBOUNCE_MS,
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
    throw new Error(body.error || `Remote sync failed (${res.status})`);
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
    throw new Error(body.error || `Remote pull failed (${res.status})`);
  }
  return body;
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

  try {
    for (;;) {
      const rows = peekOutbox(db, BATCH_SIZE);
      if (!rows.length) break;

      const result = await postBatch(buildBatchPayload(rows));
      const applied = Number(result.applied) || rows.length;
      totalApplied += applied;
      deleteOutboxUpTo(db, rows[rows.length - 1].id);

      if (rows.length < BATCH_SIZE) break;
    }

    await pullFromRemote();
    lastApplied = totalApplied;
    lastSyncAt = new Date().toISOString();
    if (totalApplied > 0) {
      console.log(`[remote-api-sync] Applied ${totalApplied} change(s) → ${process.env.REMOTE_API_URL}`);
    }
    return { ok: true, lastSyncAt, applied: totalApplied };
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
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    syncNow().catch(() => {});
  }, DEBOUNCE_MS);
}

function start() {
  if (!isEnabled() || pullTimer) return;
  lastPulledId = readLastPulledId();
  setTimeout(() => {
    pullFromRemote().catch((err) => {
      lastError = err.message;
      console.error("[remote-api-sync]", err.message);
    });
  }, 1200);
  pullTimer = setInterval(() => {
    pullFromRemote().catch((err) => {
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
  scheduleSyncAfterWrite,
  pullFromRemote,
  start,
};
