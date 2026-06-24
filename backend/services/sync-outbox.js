const { SYNC_TABLES } = require("./sync-registry");

const SUPPRESS_KEY = "suppress_outbox";

function ensureOutboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      op         TEXT NOT NULL,
      row_pk     TEXT NOT NULL,
      row_json   TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sync_outbox_id ON sync_outbox(id);
  `);
}

function suppressCondition() {
  return `NOT COALESCE((SELECT value FROM sync_meta WHERE key='${SUPPRESS_KEY}'), '') = '1'`;
}

function jsonObjectExpr(columns, rowAlias) {
  return columns.map((col) => `'${col}', ${rowAlias}.${col}`).join(", ");
}

function installTriggers(db) {
  ensureOutboxSchema(db);

  for (const { name: table, pk } of SYNC_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.length) continue;

    const pkExpr = (alias) => `${alias}.${pk}`;
    const insertJson = jsonObjectExpr(columns, "NEW");
    const updateJson = jsonObjectExpr(columns, "NEW");
    const when = suppressCondition();

    db.exec(`DROP TRIGGER IF EXISTS sync_outbox_${table}_insert`);
    db.exec(`DROP TRIGGER IF EXISTS sync_outbox_${table}_update`);
    db.exec(`DROP TRIGGER IF EXISTS sync_outbox_${table}_delete`);

    db.exec(`
      CREATE TRIGGER sync_outbox_${table}_insert
      AFTER INSERT ON ${table}
      WHEN ${when}
      BEGIN
        INSERT INTO sync_outbox (table_name, op, row_pk, row_json)
        VALUES (
          '${table}',
          'upsert',
          CAST(${pkExpr("NEW")} AS TEXT),
          json_object(${insertJson})
        );
      END;
    `);

    db.exec(`
      CREATE TRIGGER sync_outbox_${table}_update
      AFTER UPDATE ON ${table}
      WHEN ${when}
      BEGIN
        INSERT INTO sync_outbox (table_name, op, row_pk, row_json)
        VALUES (
          '${table}',
          'upsert',
          CAST(${pkExpr("NEW")} AS TEXT),
          json_object(${updateJson})
        );
      END;
    `);

    db.exec(`
      CREATE TRIGGER sync_outbox_${table}_delete
      AFTER DELETE ON ${table}
      WHEN ${when}
      BEGIN
        INSERT INTO sync_outbox (table_name, op, row_pk, row_json)
        VALUES (
          '${table}',
          'delete',
          CAST(${pkExpr("OLD")} AS TEXT),
          NULL
        );
      END;
    `);
  }
}

function setSuppressOutbox(db, suppress) {
  if (suppress) {
    db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, '1')").run(SUPPRESS_KEY);
  } else {
    db.prepare("DELETE FROM sync_meta WHERE key=?").run(SUPPRESS_KEY);
  }
}

function peekOutbox(db, limit = 300) {
  return db.prepare(`
    SELECT id, table_name, op, row_pk, row_json, created_at
    FROM sync_outbox
    ORDER BY id
    LIMIT ?
  `).all(limit);
}

function peekOutboxSince(db, afterId = 0, limit = 300) {
  return db.prepare(`
    SELECT id, table_name, op, row_pk, row_json, created_at
    FROM sync_outbox
    WHERE id > ?
    ORDER BY id
    LIMIT ?
  `).all(afterId, limit);
}

function deleteOutboxUpTo(db, maxId) {
  db.prepare("DELETE FROM sync_outbox WHERE id <= ?").run(maxId);
}

function enqueueReplicationFeed(db, items = []) {
  if (!Array.isArray(items) || !items.length) return 0;
  ensureOutboxSchema(db);
  const ins = db.prepare(`
    INSERT INTO sync_outbox (table_name, op, row_pk, row_json)
    VALUES (?, ?, ?, ?)
  `);
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const table = item.table || item.table_name;
      if (!table) continue;
      const row = typeof item.row === "object" && item.row !== null
        ? item.row
        : (item.row_json ? JSON.parse(item.row_json) : null);
      ins.run(
        table,
        item.op || "upsert",
        String(item.row_pk),
        row ? JSON.stringify(row) : null
      );
      n += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

function clearStuckSuppressFlag(db) {
  db.prepare("DELETE FROM sync_meta WHERE key=?").run(SUPPRESS_KEY);
}

function outboxCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get().n;
}

module.exports = {
  installTriggers,
  setSuppressOutbox,
  peekOutbox,
  deleteOutboxUpTo,
  peekOutboxSince,
  outboxCount,
  ensureOutboxSchema,
  enqueueReplicationFeed,
  clearStuckSuppressFlag,
};
