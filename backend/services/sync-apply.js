const { getTableDef, isSyncTable } = require("./sync-registry");
const { setSuppressOutbox, enqueueReplicationFeed } = require("./sync-outbox");

function getSyncToken() {
  return process.env.SYNC_API_TOKEN || process.env.REMOTE_API_TOKEN || "";
}

function isReceiverEnabled() {
  return Boolean(getSyncToken());
}

function authMiddleware(req, res, next) {
  const expected = getSyncToken();
  if (!expected) {
    return res.status(503).json({ error: "Sync API is not configured on this server (set SYNC_API_TOKEN)" });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.body?.token || "";
  if (token !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function coerceValue(value) {
  if (value === null || value === undefined) return null;
  return value;
}

function applyUpsert(db, table, row) {
  const def = getTableDef(table);
  if (!def) throw new Error(`Unknown sync table: ${table}`);
  if (!row || typeof row !== "object") throw new Error(`Invalid row for ${table}`);

  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  if (!cols.includes(def.pk)) {
    throw new Error(`Row for ${table} missing primary key ${def.pk}`);
  }

  const placeholders = cols.map(() => "?").join(", ");
  const updateCols = cols.filter((c) => c !== def.pk);
  const updateClause = updateCols.length
    ? updateCols.map((c) => `${c}=excluded.${c}`).join(", ")
    : `${def.pk}=excluded.${def.pk}`;

  const sql = `
    INSERT INTO ${table} (${cols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(${def.pk}) DO UPDATE SET ${updateClause}
  `;
  db.prepare(sql).run(...cols.map((c) => coerceValue(row[c])));
}

function applyDelete(db, table, rowPk) {
  const def = getTableDef(table);
  if (!def) throw new Error(`Unknown sync table: ${table}`);
  db.prepare(`DELETE FROM ${table} WHERE ${def.pk}=?`).run(rowPk);
}

function applyMutation(db, item) {
  const table = item.table || item.table_name;
  const op = item.op;
  if (!isSyncTable(table)) throw new Error(`Sync not allowed for table: ${table}`);

  if (op === "delete") {
    applyDelete(db, table, item.row_pk);
    return;
  }

  if (op === "upsert") {
    const row = typeof item.row === "object" && item.row !== null
      ? item.row
      : JSON.parse(item.row_json || "{}");
    applyUpsert(db, table, row);
    return;
  }

  throw new Error(`Unknown sync op: ${op}`);
}

function applyBatch(db, items = [], options = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: true, applied: 0 };
  }

  const replicate = options.replicate === true;

  let applied = 0;
  db.exec("BEGIN");
  setSuppressOutbox(db, true);
  try {
    for (const item of items) {
      applyMutation(db, item);
      applied += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    setSuppressOutbox(db, false);
  }

  // Only on the hub receiver (VPS): fan-out so mobile / other clients can pull changes.
  if (replicate) {
    try {
      enqueueReplicationFeed(db, items);
    } catch (err) {
      console.error("[sync-apply] replication feed:", err.message);
    }
  }

  return { ok: true, applied };
}

module.exports = {
  isReceiverEnabled,
  authMiddleware,
  applyBatch,
  applyMutation,
};
