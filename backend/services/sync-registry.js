/**
 * Tables replicated from local (Windows) → VPS via /api/sync/apply.
 * Each entry: table name + primary key column.
 */
const SYNC_TABLES = [
  { name: "domain_lists", pk: "id" },
  { name: "domain_list_items", pk: "id" },
  { name: "campaigns", pk: "id" },
  { name: "campaign_domains", pk: "id" },
  { name: "processing_results", pk: "id" },
  { name: "processing_jobs", pk: "id" },
  { name: "prospects", pk: "id" },
  { name: "outreach_messages", pk: "id" },
  { name: "final_prospects", pk: "id" },
  { name: "marketing_accounts", pk: "id" },
  { name: "marketing_settings", pk: "key" },
  { name: "marketing_assignment_cursors", pk: "channel" },
  { name: "final_prospect_account_assignments", pk: "id" },
  { name: "prospect_account_assignments", pk: "id" },
  { name: "prospect_message_tracking", pk: "id" },
];

const TABLE_BY_NAME = new Map(SYNC_TABLES.map((t) => [t.name, t]));

function getTableDef(tableName) {
  return TABLE_BY_NAME.get(tableName) || null;
}

function isSyncTable(tableName) {
  return TABLE_BY_NAME.has(tableName);
}

module.exports = { SYNC_TABLES, getTableDef, isSyncTable };
