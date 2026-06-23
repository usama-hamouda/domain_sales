const { db } = require("../db");
const { peekOutbox, deleteOutboxUpTo, outboxCount } = require("./sync-outbox");

const DEBOUNCE_MS = Number(process.env.REMOTE_API_SYNC_DEBOUNCE_MS || process.env.REMOTE_DB_SYNC_DEBOUNCE_MS || 4000);
const BATCH_SIZE = Number(process.env.REMOTE_API_SYNC_BATCH_SIZE || 250);

let debounceTimer = null;
let syncing = false;
let pendingSync = false;
let lastSyncAt = null;
let lastError = null;
let lastApplied = 0;

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
    pendingOutbox: isEnabled() ? outboxCount(db) : 0,
  };
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
  const token = process.env.REMOTE_API_TOKEN || process.env.SYNC_API_TOKEN;
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

module.exports = {
  isEnabled,
  getConfig,
  getStatus,
  syncNow,
  scheduleSyncAfterWrite,
};
