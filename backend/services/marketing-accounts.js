const { db } = require("../db");
const messageTracking = require("./message-tracking");
const { findLinkedProspectId } = require("./prospect-link");

const ASSIGNMENT_CHANNELS = ["gmail", "whatsapp", "linkedin", "instagram", "facebook"];

const CHANNEL_LABELS = {
  gmail: "Email (Gmail)",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
};

const CHANNEL_FIELDS = {
  gmail: "email",
  whatsapp: "whatsapp",
  linkedin: "linkedin",
  instagram: "instagram",
  facebook: "facebook",
};

const CURSOR_KEY = "account";

function trimOrNull(value) {
  const v = value?.trim();
  return v || null;
}

function normalizeContactFields(data) {
  const fields = {
    email: trimOrNull(data.email),
    whatsapp: trimOrNull(data.whatsapp),
    linkedin: trimOrNull(data.linkedin),
    instagram: trimOrNull(data.instagram),
    facebook: trimOrNull(data.facebook),
  };

  // Backward compatibility with single-channel API payloads.
  if (data.channel && data.identifier && CHANNEL_FIELDS[data.channel]) {
    const col = CHANNEL_FIELDS[data.channel];
    if (!fields[col]) fields[col] = trimOrNull(data.identifier);
  }

  return fields;
}

function hasAnyContact(fields) {
  return Object.values(fields).some(Boolean);
}

function getAccountChannelValue(account, channel) {
  const field = CHANNEL_FIELDS[channel];
  if (!field) return null;
  return trimOrNull(account[field]);
}

function getConfiguredChannels(account) {
  return ASSIGNMENT_CHANNELS.filter((ch) => getAccountChannelValue(account, ch));
}

function expandAssignmentToChannels(accountRow) {
  if (!accountRow) return [];
  return ASSIGNMENT_CHANNELS.reduce((acc, channel) => {
    const identifier = getAccountChannelValue(accountRow, channel);
    if (!identifier) return acc;
    acc.push({
      channel,
      marketing_account_id: accountRow.marketing_account_id ?? accountRow.id,
      account_name: accountRow.account_name || accountRow.name,
      account_identifier: identifier,
    });
    return acc;
  }, []);
}

function getMaxProspectsPerAccount() {
  const row = db.prepare("SELECT value FROM marketing_settings WHERE key='max_prospects_per_account'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function setMaxProspectsPerAccount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: "max_prospects_per_account must be a positive number" };
  }
  db.prepare(`
    INSERT INTO marketing_settings (key, value) VALUES ('max_prospects_per_account', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(n));
  return { ok: true, maxProspectsPerAccount: n };
}

function getSettings() {
  return {
    maxProspectsPerAccount: getMaxProspectsPerAccount(),
    followUpIntervalDays: messageTracking.getDefaultFollowUpInterval(),
  };
}

function getAccountUsageCount(accountId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM final_prospect_account_assignments WHERE marketing_account_id=?"
  ).get(accountId).c;
}

function accountToRow(row) {
  if (!row) return null;
  const usage = getAccountUsageCount(row.id);
  const max = getMaxProspectsPerAccount();
  const configuredChannels = getConfiguredChannels(row);
  return {
    id: row.id,
    name: row.name,
    email: row.email || null,
    whatsapp: row.whatsapp || null,
    linkedin: row.linkedin || null,
    instagram: row.instagram || null,
    facebook: row.facebook || null,
    notes: row.notes || null,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    usage_count: usage,
    max_prospects: max,
    exhausted: usage >= max,
    configured_channels: configuredChannels,
    channel_labels: configuredChannels.map((c) => CHANNEL_LABELS[c] || c),
  };
}

function listAccounts() {
  return db.prepare("SELECT * FROM marketing_accounts ORDER BY id").all().map(accountToRow);
}

function getAccount(id) {
  return accountToRow(db.prepare("SELECT * FROM marketing_accounts WHERE id=?").get(id));
}

function createAccount(data) {
  const { name, notes, is_active = true } = data;
  if (!name?.trim()) return { ok: false, error: "name required" };

  const contacts = normalizeContactFields(data);
  if (!hasAnyContact(contacts)) {
    return { ok: false, error: "At least one contact channel is required (email, whatsapp, linkedin, instagram, or facebook)" };
  }

  const info = db.prepare(`
    INSERT INTO marketing_accounts (name, email, whatsapp, linkedin, instagram, facebook, notes, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    contacts.email,
    contacts.whatsapp,
    contacts.linkedin,
    contacts.instagram,
    contacts.facebook,
    notes?.trim() || null,
    is_active ? 1 : 0,
  );

  return { ok: true, account: getAccount(info.lastInsertRowid) };
}

function updateAccount(id, data) {
  const existing = db.prepare("SELECT * FROM marketing_accounts WHERE id=?").get(id);
  if (!existing) return { ok: false, error: "Account not found" };

  const contacts = normalizeContactFields({
    email: data.email !== undefined ? data.email : existing.email,
    whatsapp: data.whatsapp !== undefined ? data.whatsapp : existing.whatsapp,
    linkedin: data.linkedin !== undefined ? data.linkedin : existing.linkedin,
    instagram: data.instagram !== undefined ? data.instagram : existing.instagram,
    facebook: data.facebook !== undefined ? data.facebook : existing.facebook,
    channel: data.channel,
    identifier: data.identifier,
  });

  if (!hasAnyContact(contacts)) {
    return { ok: false, error: "At least one contact channel is required" };
  }

  db.prepare(`
    UPDATE marketing_accounts SET
      name=COALESCE(?, name),
      email=?,
      whatsapp=?,
      linkedin=?,
      instagram=?,
      facebook=?,
      notes=COALESCE(?, notes),
      is_active=COALESCE(?, is_active),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    data.name?.trim() ?? null,
    contacts.email,
    contacts.whatsapp,
    contacts.linkedin,
    contacts.instagram,
    contacts.facebook,
    data.notes !== undefined ? (data.notes?.trim() || null) : null,
    data.is_active !== undefined ? (data.is_active ? 1 : 0) : null,
    id,
  );

  return { ok: true, account: getAccount(id) };
}

function deleteAccount(id) {
  const existing = db.prepare("SELECT id FROM marketing_accounts WHERE id=?").get(id);
  if (!existing) return { ok: false, error: "Account not found" };
  db.prepare("DELETE FROM marketing_accounts WHERE id=?").run(id);
  return { ok: true };
}

function getActiveAccounts() {
  return db.prepare("SELECT * FROM marketing_accounts WHERE is_active=1 ORDER BY id ASC").all();
}

function setCursor(nextIndex) {
  const existing = db.prepare("SELECT channel FROM marketing_assignment_cursors WHERE channel=?").get(CURSOR_KEY);
  if (existing) {
    db.prepare("UPDATE marketing_assignment_cursors SET next_index=? WHERE channel=?").run(nextIndex, CURSOR_KEY);
  } else {
    db.prepare("INSERT INTO marketing_assignment_cursors (channel, next_index) VALUES (?, ?)").run(CURSOR_KEY, nextIndex);
  }
}

function pickNextAccount() {
  const accounts = getActiveAccounts();
  if (!accounts.length) {
    return { account: null, warning: "No active marketing account configured. Add accounts in Marketing Accounts." };
  }

  const max = getMaxProspectsPerAccount();
  const cursorRow = db.prepare("SELECT next_index FROM marketing_assignment_cursors WHERE channel=?").get(CURSOR_KEY);
  const startIdx = cursorRow?.next_index ?? 0;
  const n = accounts.length;

  for (let i = 0; i < n; i += 1) {
    const idx = (startIdx + i) % n;
    const acc = accounts[idx];
    const usage = getAccountUsageCount(acc.id);
    if (usage < max) {
      setCursor((idx + 1) % n);
      const warning = usage + 1 >= max
        ? `Warning: "${acc.name}" will reach max capacity (${max} prospects) after this assignment`
        : null;
      return { account: acc, warning };
    }
  }

  return {
    account: null,
    warning: `All marketing accounts exhausted (max ${max} prospects per account)`,
  };
}

function getAssignmentsForFinalProspect(finalProspectId) {
  const row = db.prepare(`
    SELECT
      fpa.final_prospect_id,
      fpa.marketing_account_id,
      fpa.assigned_at,
      ma.name AS account_name,
      ma.email,
      ma.whatsapp,
      ma.linkedin,
      ma.instagram,
      ma.facebook
    FROM final_prospect_account_assignments fpa
    JOIN marketing_accounts ma ON ma.id = fpa.marketing_account_id
    WHERE fpa.final_prospect_id=?
  `).get(finalProspectId);
  return expandAssignmentToChannels(row);
}

function getAssignmentsForProspect(prospectId) {
  const row = db.prepare(`
    SELECT
      paa.prospect_id,
      paa.marketing_account_id,
      paa.assigned_at,
      ma.name AS account_name,
      ma.email,
      ma.whatsapp,
      ma.linkedin,
      ma.instagram,
      ma.facebook
    FROM prospect_account_assignments paa
    JOIN marketing_accounts ma ON ma.id = paa.marketing_account_id
    WHERE paa.prospect_id=?
  `).get(prospectId);
  if (row) return expandAssignmentToChannels(row);

  const fp = db.prepare("SELECT id FROM final_prospects WHERE prospect_id=?").get(prospectId);
  if (fp) {
    syncAssignmentsToProspect(fp.id, prospectId);
    return getAssignmentsForFinalProspect(fp.id);
  }
  return [];
}

function assignAccountsToFinalProspect(finalProspectId) {
  const existing = db.prepare(
    "SELECT COUNT(*) AS c FROM final_prospect_account_assignments WHERE final_prospect_id=?"
  ).get(finalProspectId).c;
  if (existing > 0) {
    return { assignments: getAssignmentsForFinalProspect(finalProspectId), warnings: [] };
  }

  const { account, warning } = pickNextAccount();
  const warnings = [];

  if (!account) {
    if (warning) warnings.push(warning);
    return { assignments: [], warnings };
  }

  if (warning) warnings.push(warning);

  const out = setMarketingAccountForFinalProspect(finalProspectId, account.id);
  return {
    assignments: out.assignments || [],
    warnings: [...warnings, ...(out.warnings || [])],
  };
}

function setMarketingAccountForFinalProspect(finalProspectId, marketingAccountId) {
  const account = db.prepare("SELECT * FROM marketing_accounts WHERE id=?").get(marketingAccountId);
  if (!account) {
    return { ok: false, error: "Marketing account not found" };
  }

  const warnings = [];
  const max = getMaxProspectsPerAccount();
  const usage = getAccountUsageCount(marketingAccountId);
  const alreadyAssigned = db.prepare(
    "SELECT 1 FROM final_prospect_account_assignments WHERE final_prospect_id=? AND marketing_account_id=?"
  ).get(finalProspectId, marketingAccountId);
  if (!alreadyAssigned && usage >= max) {
    warnings.push(`Account "${account.name}" is at capacity (${usage}/${max}). Assignment allowed but account is full.`);
  }

  db.prepare(`
    INSERT INTO final_prospect_account_assignments (final_prospect_id, marketing_account_id)
    VALUES (?, ?)
    ON CONFLICT(final_prospect_id) DO UPDATE SET
      marketing_account_id=excluded.marketing_account_id,
      assigned_at=datetime('now')
  `).run(finalProspectId, marketingAccountId);

  messageTracking.getOrCreateTracking(finalProspectId);

  const fp = db.prepare("SELECT prospect_id FROM final_prospects WHERE id=?").get(finalProspectId);
  if (fp?.prospect_id) {
    syncAssignmentsToProspect(finalProspectId, fp.prospect_id);
  }

  const missingChannels = ASSIGNMENT_CHANNELS.filter((ch) => !getAccountChannelValue(account, ch));
  if (missingChannels.length) {
    const labels = missingChannels.map((c) => CHANNEL_LABELS[c] || c).join(", ");
    warnings.push(
      `Assigned "${account.name}" but it has no contact info for: ${labels}. Update the account to enable those channels.`,
    );
  }

  return {
    ok: true,
    assignments: getAssignmentsForFinalProspect(finalProspectId),
    warnings,
  };
}

function setMarketingAccountForProspect(prospectId, marketingAccountId) {
  const fp = db.prepare("SELECT id FROM final_prospects WHERE prospect_id=?").get(prospectId);
  if (fp) {
    return setMarketingAccountForFinalProspect(fp.id, marketingAccountId);
  }

  const account = db.prepare("SELECT * FROM marketing_accounts WHERE id=?").get(marketingAccountId);
  if (!account) {
    return { ok: false, error: "Marketing account not found" };
  }

  db.prepare(`
    INSERT INTO prospect_account_assignments (prospect_id, marketing_account_id)
    VALUES (?, ?)
    ON CONFLICT(prospect_id) DO UPDATE SET
      marketing_account_id=excluded.marketing_account_id,
      assigned_at=datetime('now')
  `).run(prospectId, marketingAccountId);

  const warnings = [];
  const missingChannels = ASSIGNMENT_CHANNELS.filter((ch) => !getAccountChannelValue(account, ch));
  if (missingChannels.length) {
    const labels = missingChannels.map((c) => CHANNEL_LABELS[c] || c).join(", ");
    warnings.push(
      `Assigned "${account.name}" but it has no contact info for: ${labels}. Add to final list to sync tracking.`,
    );
  }

  return {
    ok: true,
    assignments: getAssignmentsForProspect(prospectId),
    warnings,
  };
}

function syncAssignmentsToProspect(finalProspectId, prospectId) {
  const row = db.prepare(
    "SELECT marketing_account_id FROM final_prospect_account_assignments WHERE final_prospect_id=?"
  ).get(finalProspectId);
  if (!row) return;

  db.prepare(`
    INSERT INTO prospect_account_assignments (prospect_id, marketing_account_id)
    VALUES (?, ?)
    ON CONFLICT(prospect_id) DO UPDATE SET
      marketing_account_id=excluded.marketing_account_id,
      assigned_at=datetime('now')
  `).run(prospectId, row.marketing_account_id);
}

function resolveCampaignDomainIdForProspect(row) {
  if (row.campaign_domain_id) return row.campaign_domain_id;

  const byListItem = db.prepare(
    "SELECT id FROM campaign_domains WHERE list_item_id=? ORDER BY id LIMIT 1"
  ).get(row.list_item_id);
  if (byListItem) return byListItem.id;

  const listItem = db.prepare(
    "SELECT list_id, domain FROM domain_list_items WHERE id=?"
  ).get(row.list_item_id);
  if (!listItem) return null;

  const byDomain = db.prepare(`
    SELECT cd.id FROM campaign_domains cd
    JOIN domain_list_items dli ON dli.id = cd.list_item_id
    WHERE dli.list_id = ? AND LOWER(dli.domain) = LOWER(?)
    ORDER BY cd.id
    LIMIT 1
  `).get(listItem.list_id, listItem.domain);
  if (byDomain) return byDomain.id;

  if (row.website) {
    const byWebsite = db.prepare(`
      SELECT p.campaign_domain_id FROM prospects p
      JOIN campaign_domains cd ON cd.id = p.campaign_domain_id
      JOIN domain_list_items dli ON dli.id = cd.list_item_id
      WHERE dli.list_id = ? AND p.website = ?
      LIMIT 1
    `).get(listItem.list_id, row.website);
    if (byWebsite?.campaign_domain_id) return byWebsite.campaign_domain_id;
  }

  return null;
}

function listProspectsForAccount(accountId) {
  const rows = db.prepare(`
    SELECT
      fp.id AS final_prospect_id,
      fp.prospect_id,
      fp.name,
      fp.website,
      fp.email,
      fp.campaign_domain_id,
      fp.list_item_id,
      fpa.assigned_at,
      cd.domain AS campaign_domain,
      dli.domain AS list_domain
    FROM final_prospect_account_assignments fpa
    JOIN final_prospects fp ON fp.id = fpa.final_prospect_id
    LEFT JOIN campaign_domains cd ON cd.id = fp.campaign_domain_id
    LEFT JOIN domain_list_items dli ON dli.id = fp.list_item_id
    WHERE fpa.marketing_account_id=?
    ORDER BY fpa.assigned_at DESC, fp.id DESC
  `).all(accountId);

  const enriched = rows.map((row) => {
    const resolvedCampaignDomainId = resolveCampaignDomainIdForProspect(row);
    const linkedProspectId = row.prospect_id || findLinkedProspectId({
      prospect_id: row.prospect_id,
      website: row.website,
      email: row.email,
      list_item_id: row.list_item_id,
    });
    return {
      ...row,
      resolved_campaign_domain_id: resolvedCampaignDomainId,
      campaign_domain_id: row.campaign_domain_id || resolvedCampaignDomainId,
      linked_prospect_id: linkedProspectId,
    };
  });

  return messageTracking.enrichProspectsWithTracking(enriched);
}

function enrichFinalProspectsWithAccounts(rows) {
  return rows.map((row) => ({
    ...row,
    account_assignments: getAssignmentsForFinalProspect(row.id),
  }));
}

module.exports = {
  ASSIGNMENT_CHANNELS,
  CHANNEL_LABELS,
  CHANNEL_FIELDS,
  getSettings,
  setMaxProspectsPerAccount,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  assignAccountsToFinalProspect,
  setMarketingAccountForFinalProspect,
  setMarketingAccountForProspect,
  syncAssignmentsToProspect,
  getAssignmentsForFinalProspect,
  getAssignmentsForProspect,
  listProspectsForAccount,
  enrichFinalProspectsWithAccounts,
  getAccountUsageCount,
  getMaxProspectsPerAccount,
  getAccountChannelValue,
  getConfiguredChannels,
};
