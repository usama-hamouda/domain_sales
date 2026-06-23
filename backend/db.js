const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "domain_sales.db");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS domain_lists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    list_date   TEXT NOT NULL,
    col_order   TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS domain_list_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id         INTEGER NOT NULL REFERENCES domain_lists(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL,
    position        INTEGER DEFAULT 0,
    row_data        TEXT,
    selected        INTEGER DEFAULT 0,
    proc_status     TEXT DEFAULT 'pending',
    proc_progress   TEXT,
    google_exact    INTEGER DEFAULT 0,
    google_partial  INTEGER DEFAULT 0,
    google_title    INTEGER DEFAULT 0,
    linkedin_exact  INTEGER DEFAULT 0,
    linkedin_partial INTEGER DEFAULT 0,
    instagram_exact INTEGER DEFAULT 0,
    instagram_partial INTEGER DEFAULT 0,
    zfbot_count     INTEGER DEFAULT 0,
    crunchbase_exact INTEGER DEFAULT 0,
    crunchbase_partial INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaign_domains (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    domain      TEXT NOT NULL,
    list_item_id INTEGER REFERENCES domain_list_items(id) ON DELETE SET NULL,
    row_data    TEXT,
    position    INTEGER DEFAULT 0,
    google_exact INTEGER DEFAULT 0,
    google_partial INTEGER DEFAULT 0,
    linkedin_exact INTEGER DEFAULT 0,
    instagram_exact INTEGER DEFAULT 0,
    zfbot_count INTEGER DEFAULT 0,
    crunchbase_exact INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(campaign_id, domain)
  );

  CREATE TABLE IF NOT EXISTS processing_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_item_id INTEGER NOT NULL REFERENCES domain_list_items(id) ON DELETE CASCADE,
    step        TEXT NOT NULL,
    match_type  TEXT,
    result_domain TEXT,
    title       TEXT,
    snippet     TEXT,
    url         TEXT,
    extra       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processing_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id     INTEGER NOT NULL REFERENCES domain_lists(id) ON DELETE CASCADE,
    status      TEXT DEFAULT 'idle',
    mode        TEXT DEFAULT 'all',
    selected_ids TEXT,
    current_index INTEGER DEFAULT 0,
    current_step TEXT,
    steps       TEXT,
    error       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prospects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_domain_id INTEGER NOT NULL REFERENCES campaign_domains(id) ON DELETE CASCADE,
    name        TEXT,
    website     TEXT,
    email       TEXT,
    phone       TEXT,
    linkedin    TEXT,
    instagram   TEXT,
    facebook    TEXT,
    whatsapp    TEXT,
    twitter     TEXT,
    notes       TEXT,
    scrape_status TEXT DEFAULT 'pending',
    source      TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS outreach_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL,
    subject     TEXT,
    body        TEXT,
    sent_at     TEXT,
    sent_via    TEXT,
    status      TEXT DEFAULT 'draft',
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(prospect_id, slot)
  );

  CREATE INDEX IF NOT EXISTS idx_list_items_list ON domain_list_items(list_id);
  CREATE INDEX IF NOT EXISTS idx_list_items_domain ON domain_list_items(domain);
  CREATE INDEX IF NOT EXISTS idx_campaign_domains_camp ON campaign_domains(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_proc_results_item ON processing_results(list_item_id);
  CREATE INDEX IF NOT EXISTS idx_prospects_camp_domain ON prospects(campaign_domain_id);

  CREATE TABLE IF NOT EXISTS final_prospects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_item_id INTEGER NOT NULL REFERENCES domain_list_items(id) ON DELETE CASCADE,
    campaign_domain_id INTEGER REFERENCES campaign_domains(id) ON DELETE SET NULL,
    processing_result_id INTEGER REFERENCES processing_results(id) ON DELETE SET NULL,
    prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
    name        TEXT,
    website     TEXT,
    email       TEXT,
    phone       TEXT,
    linkedin    TEXT,
    instagram   TEXT,
    facebook    TEXT,
    whatsapp    TEXT,
    twitter     TEXT,
    notes       TEXT,
    source      TEXT,
    step        TEXT,
    match_type  TEXT,
    result_domain TEXT,
    title       TEXT,
    snippet     TEXT,
    url         TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(list_item_id, processing_result_id),
    UNIQUE(list_item_id, prospect_id)
  );

  CREATE INDEX IF NOT EXISTS idx_final_prospects_item ON final_prospects(list_item_id);
  CREATE INDEX IF NOT EXISTS idx_final_prospects_camp ON final_prospects(campaign_domain_id);

  CREATE TABLE IF NOT EXISTS marketing_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT,
    whatsapp    TEXT,
    linkedin    TEXT,
    instagram   TEXT,
    facebook    TEXT,
    is_active   INTEGER DEFAULT 1,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS marketing_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS marketing_assignment_cursors (
    channel    TEXT PRIMARY KEY,
    next_index INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS final_prospect_account_assignments (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    final_prospect_id    INTEGER NOT NULL REFERENCES final_prospects(id) ON DELETE CASCADE,
    marketing_account_id INTEGER NOT NULL REFERENCES marketing_accounts(id) ON DELETE CASCADE,
    assigned_at          TEXT DEFAULT (datetime('now')),
    UNIQUE(final_prospect_id)
  );

  CREATE TABLE IF NOT EXISTS prospect_account_assignments (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id          INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    marketing_account_id INTEGER NOT NULL REFERENCES marketing_accounts(id) ON DELETE CASCADE,
    assigned_at          TEXT DEFAULT (datetime('now')),
    UNIQUE(prospect_id)
  );

  CREATE TABLE IF NOT EXISTS prospect_message_tracking (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    final_prospect_id      INTEGER NOT NULL REFERENCES final_prospects(id) ON DELETE CASCADE,
    prospect_id            INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
    start_date             TEXT NOT NULL,
    follow_up_interval_days INTEGER DEFAULT 5,
    updated_at             TEXT DEFAULT (datetime('now')),
    UNIQUE(final_prospect_id)
  );

  CREATE INDEX IF NOT EXISTS idx_fp_assignments_fp ON final_prospect_account_assignments(final_prospect_id);
  CREATE INDEX IF NOT EXISTS idx_fp_assignments_account ON final_prospect_account_assignments(marketing_account_id);
  CREATE INDEX IF NOT EXISTS idx_prospect_assignments_prospect ON prospect_account_assignments(prospect_id);
`);

try {
  db.exec("ALTER TABLE processing_jobs ADD COLUMN results_mode TEXT DEFAULT 'overwrite'");
} catch {
  // Column already exists.
}

try {
  db.exec("ALTER TABLE final_prospects ADD COLUMN scrape_status TEXT DEFAULT 'pending'");
} catch {
  // Column already exists.
}

try {
  db.prepare("INSERT OR IGNORE INTO marketing_settings (key, value) VALUES ('max_prospects_per_account', '50')").run();
  db.prepare("INSERT OR IGNORE INTO marketing_settings (key, value) VALUES ('follow_up_interval_days', '5')").run();
} catch {
  // Settings table may not exist yet on first run before CREATE.
}

try {
  db.prepare("UPDATE marketing_settings SET value='5' WHERE key='follow_up_interval_days' AND value='3'").run();
  db.prepare("UPDATE prospect_message_tracking SET follow_up_interval_days=5 WHERE follow_up_interval_days=3").run();
} catch {
  // Tables may not exist yet on first run.
}

function migrateMarketingAccountsSchema() {
  const cols = db.prepare("PRAGMA table_info(marketing_accounts)").all();
  const colNames = new Set(cols.map((c) => c.name));
  const hasLegacyChannel = colNames.has("channel");

  if (!colNames.has("email")) {
    for (const col of ["email", "whatsapp", "linkedin", "instagram", "facebook"]) {
      try {
        db.exec(`ALTER TABLE marketing_accounts ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists.
      }
    }
  }

  if (!hasLegacyChannel) return;

  const channelMap = {
    gmail: "email",
    whatsapp: "whatsapp",
    linkedin: "linkedin",
    instagram: "instagram",
    facebook: "facebook",
  };
  for (const [channel, col] of Object.entries(channelMap)) {
    db.prepare(`
      UPDATE marketing_accounts SET ${col} = identifier
      WHERE channel = ? AND identifier IS NOT NULL AND TRIM(identifier) != ''
        AND (${col} IS NULL OR TRIM(${col}) = '')
    `).run(channel);
  }

  db.exec(`
    CREATE TABLE marketing_accounts_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      email       TEXT,
      whatsapp    TEXT,
      linkedin    TEXT,
      instagram   TEXT,
      facebook    TEXT,
      is_active   INTEGER DEFAULT 1,
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    INSERT INTO marketing_accounts_new (id, name, email, whatsapp, linkedin, instagram, facebook, is_active, notes, created_at, updated_at)
    SELECT id, name, email, whatsapp, linkedin, instagram, facebook, is_active, notes, created_at, updated_at
    FROM marketing_accounts
  `);

  db.exec("DROP TABLE marketing_accounts");
  db.exec("ALTER TABLE marketing_accounts_new RENAME TO marketing_accounts");
}

function migrateAssignmentTables() {
  const fpCols = db.prepare("PRAGMA table_info(final_prospect_account_assignments)").all();
  if (!fpCols.some((c) => c.name === "channel")) return;

  db.exec(`
    CREATE TABLE final_prospect_account_assignments_new (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      final_prospect_id    INTEGER NOT NULL REFERENCES final_prospects(id) ON DELETE CASCADE,
      marketing_account_id INTEGER NOT NULL REFERENCES marketing_accounts(id) ON DELETE CASCADE,
      assigned_at          TEXT DEFAULT (datetime('now')),
      UNIQUE(final_prospect_id)
    );
  `);

  const finalProspects = db.prepare(
    "SELECT DISTINCT final_prospect_id FROM final_prospect_account_assignments"
  ).all();
  for (const { final_prospect_id } of finalProspects) {
    const pick = db.prepare(`
      SELECT marketing_account_id, assigned_at FROM final_prospect_account_assignments
      WHERE final_prospect_id=?
      ORDER BY CASE channel WHEN 'gmail' THEN 0 ELSE 1 END, id
      LIMIT 1
    `).get(final_prospect_id);
    if (pick) {
      db.prepare(`
        INSERT INTO final_prospect_account_assignments_new (final_prospect_id, marketing_account_id, assigned_at)
        VALUES (?, ?, ?)
      `).run(final_prospect_id, pick.marketing_account_id, pick.assigned_at);
    }
  }

  db.exec("DROP TABLE final_prospect_account_assignments");
  db.exec("ALTER TABLE final_prospect_account_assignments_new RENAME TO final_prospect_account_assignments");

  db.exec(`
    CREATE TABLE prospect_account_assignments_new (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      prospect_id          INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
      marketing_account_id INTEGER NOT NULL REFERENCES marketing_accounts(id) ON DELETE CASCADE,
      assigned_at          TEXT DEFAULT (datetime('now')),
      UNIQUE(prospect_id)
    );
  `);

  const prospects = db.prepare(
    "SELECT DISTINCT prospect_id FROM prospect_account_assignments"
  ).all();
  for (const { prospect_id } of prospects) {
    const pick = db.prepare(`
      SELECT marketing_account_id, assigned_at FROM prospect_account_assignments
      WHERE prospect_id=?
      ORDER BY CASE channel WHEN 'gmail' THEN 0 ELSE 1 END, id
      LIMIT 1
    `).get(prospect_id);
    if (pick) {
      db.prepare(`
        INSERT INTO prospect_account_assignments_new (prospect_id, marketing_account_id, assigned_at)
        VALUES (?, ?, ?)
      `).run(prospect_id, pick.marketing_account_id, pick.assigned_at);
    }
  }

  db.exec("DROP TABLE prospect_account_assignments");
  db.exec("ALTER TABLE prospect_account_assignments_new RENAME TO prospect_account_assignments");
}

try {
  migrateMarketingAccountsSchema();
  migrateAssignmentTables();
  db.exec("CREATE INDEX IF NOT EXISTS idx_fp_assignments_fp ON final_prospect_account_assignments(final_prospect_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fp_assignments_account ON final_prospect_account_assignments(marketing_account_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_prospect_assignments_prospect ON prospect_account_assignments(prospect_id)");
  require("./services/phone-whatsapp").migratePhoneWhatsAppBinding(db);
  require("./services/sync-outbox").installTriggers(db);
} catch (e) {
  console.error("Marketing accounts migration error:", e.message);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function tryParse(s, fallback = null) {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    try {
      require("./services/remote-db-sync").scheduleSyncAfterWrite();
    } catch {
      // Sync module optional until server loads.
    }
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = { db, today, tryParse, DB_PATH, transaction };
