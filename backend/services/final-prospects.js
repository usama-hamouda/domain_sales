const { db, transaction } = require("../db");
const { prospectFromResult } = require("./prospect-sync");
const marketingAccounts = require("./marketing-accounts");
const contactSync = require("./prospect-contact-sync");
const { bindPhoneWhatsApp } = require("./phone-whatsapp");
const messageTracking = require("./message-tracking");
const { findLinkedProspectId } = require("./prospect-link");

function rowToFinalProspect(row) {
  if (!row) return null;
  return { ...row };
}

function getFinalProspectsByListItem(listItemId) {
  contactSync.reconcileFinalProspectsForListItem(listItemId);
  const rows = db.prepare(`
    SELECT * FROM final_prospects
    WHERE list_item_id=?
    ORDER BY created_at DESC, id DESC
  `).all(listItemId).map(rowToFinalProspect);
  return marketingAccounts.enrichFinalProspectsWithAccounts(rows);
}

function getFinalProspectsByCampaignDomain(campaignDomainId) {
  const cd = db.prepare("SELECT list_item_id FROM campaign_domains WHERE id=?").get(campaignDomainId);
  if (!cd?.list_item_id) return [];
  return getFinalProspectsByListItem(cd.list_item_id);
}

function findFinalByProcessingResult(listItemId, processingResultId) {
  return db.prepare(
    "SELECT * FROM final_prospects WHERE list_item_id=? AND processing_result_id=?"
  ).get(listItemId, processingResultId);
}

function findFinalByProspect(listItemId, prospectId) {
  return db.prepare(
    "SELECT * FROM final_prospects WHERE list_item_id=? AND prospect_id=?"
  ).get(listItemId, prospectId);
}

function fieldsFromProcessingResult(resultRow) {
  const mapped = prospectFromResult(resultRow);
  const website = mapped?.website
    || resultRow.url
    || (resultRow.result_domain ? `https://${resultRow.result_domain}` : null);
  if (!website) return null;

  return {
    name: mapped?.name || resultRow.title || resultRow.result_domain || website,
    website,
    email: null,
    phone: null,
    linkedin: mapped?.linkedin || (resultRow.step === "linkedin" ? website : null),
    instagram: mapped?.instagram || (resultRow.step === "instagram" ? website : null),
    facebook: null,
    whatsapp: null,
    twitter: null,
    source: mapped?.source || resultRow.step,
    step: resultRow.step,
    match_type: resultRow.match_type,
    result_domain: resultRow.result_domain,
    title: resultRow.title,
    snippet: resultRow.snippet,
    url: resultRow.url,
  };
}

function fieldsFromProspect(prospect) {
  if (!prospect?.website && !prospect?.linkedin && !prospect?.instagram) return null;
  return {
    name: prospect.name,
    website: prospect.website,
    email: prospect.email,
    phone: prospect.phone,
    linkedin: prospect.linkedin,
    instagram: prospect.instagram,
    facebook: prospect.facebook,
    whatsapp: prospect.whatsapp,
    twitter: prospect.twitter,
    scrape_status: prospect.scrape_status || "pending",
    source: prospect.source || "manual",
    step: prospect.source,
    match_type: null,
    result_domain: null,
    title: prospect.name,
    snippet: prospect.notes,
    url: prospect.website,
  };
}

function resolveFinalProspectIdAfterReconcile(newId, listItemId, refs = {}) {
  const stillExists = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(newId);
  if (stillExists) return newId;

  if (refs.prospectId) {
    const row = db.prepare(
      "SELECT id FROM final_prospects WHERE list_item_id=? AND prospect_id=?"
    ).get(listItemId, refs.prospectId);
    if (row) return row.id;
  }

  if (refs.processingResultId) {
    const row = db.prepare(
      "SELECT id FROM final_prospects WHERE list_item_id=? AND processing_result_id=?"
    ).get(listItemId, refs.processingResultId);
    if (row) return row.id;
  }

  return newId;
}

function insertFinalProspect(listItemId, campaignDomainId, fields, refs = {}) {
  const info = db.prepare(`
    INSERT INTO final_prospects (
      list_item_id, campaign_domain_id, processing_result_id, prospect_id,
      name, website, email, phone, linkedin, instagram, facebook, whatsapp, twitter, notes,
      source, step, match_type, result_domain, title, snippet, url, scrape_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    listItemId,
    campaignDomainId ?? null,
    refs.processingResultId ?? null,
    refs.prospectId ?? null,
    fields.name ?? null,
    fields.website ?? null,
    fields.email ?? null,
    fields.phone ?? null,
    fields.linkedin ?? null,
    fields.instagram ?? null,
    fields.facebook ?? null,
    fields.whatsapp ?? null,
    fields.twitter ?? null,
    fields.notes ?? null,
    fields.source ?? null,
    fields.step ?? null,
    fields.match_type ?? null,
    fields.result_domain ?? null,
    fields.title ?? null,
    fields.snippet ?? null,
    fields.url ?? null,
    fields.scrape_status ?? "pending",
  );
  const newId = info.lastInsertRowid;

  if (refs.prospectId) {
    contactSync.syncProspectToLinkedFinalProspects(refs.prospectId);
  } else {
    contactSync.reconcileFinalProspectsForListItem(listItemId);
  }

  const targetId = resolveFinalProspectIdAfterReconcile(newId, listItemId, refs);
  const { assignments, warnings } = marketingAccounts.assignAccountsToFinalProspect(targetId);

  const syncedRow = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(targetId);
  return { row: syncedRow, assignments, warnings };
}

function addFromProcessingResult(listItemId, processingResultId, campaignDomainId = null) {
  const existing = findFinalByProcessingResult(listItemId, processingResultId);
  if (existing) {
    contactSync.reconcileFinalProspectsForListItem(listItemId);
    const refreshed = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(existing.id);
    return {
      ok: true,
      duplicate: true,
      finalProspect: marketingAccounts.enrichFinalProspectsWithAccounts([refreshed])[0],
      warnings: [],
    };
  }

  const resultRow = db.prepare(
    "SELECT * FROM processing_results WHERE id=? AND list_item_id=?"
  ).get(processingResultId, listItemId);
  if (!resultRow) return { ok: false, error: "Processing result not found" };

  const fields = fieldsFromProcessingResult(resultRow);
  if (!fields) return { ok: false, error: "Could not build prospect from result" };

  const { row, warnings } = insertFinalProspect(listItemId, campaignDomainId, fields, { processingResultId });
  return {
    ok: true,
    duplicate: false,
    finalProspect: marketingAccounts.enrichFinalProspectsWithAccounts([row])[0],
    warnings,
  };
}

function addFromProspect(campaignDomainId, prospectId) {
  const cd = db.prepare("SELECT * FROM campaign_domains WHERE id=?").get(campaignDomainId);
  if (!cd?.list_item_id) return { ok: false, error: "Campaign domain has no linked list item" };

  const existing = findFinalByProspect(cd.list_item_id, prospectId);
  if (existing) {
    contactSync.syncProspectToLinkedFinalProspects(prospectId);
    const refreshed = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(existing.id);
    return {
      ok: true,
      duplicate: true,
      finalProspect: marketingAccounts.enrichFinalProspectsWithAccounts([refreshed])[0],
      warnings: [],
    };
  }

  const prospect = db.prepare(
    "SELECT * FROM prospects WHERE id=? AND campaign_domain_id=?"
  ).get(prospectId, campaignDomainId);
  if (!prospect) return { ok: false, error: "Prospect not found" };

  const fields = fieldsFromProspect(prospect);
  if (!fields) return { ok: false, error: "Prospect has no usable contact info" };

  const { row, warnings } = insertFinalProspect(cd.list_item_id, campaignDomainId, fields, { prospectId });
  return {
    ok: true,
    duplicate: false,
    finalProspect: marketingAccounts.enrichFinalProspectsWithAccounts([row])[0],
    warnings,
  };
}

function buildNotesAppend(contact, existingNotes) {
  let notesAppend = null;
  if (contact.contact_form_url) {
    notesAppend = `Contact form: ${contact.contact_form_url}`;
  }
  const extraPhones = Array.isArray(contact.phones_extra) ? contact.phones_extra.filter(Boolean) : [];
  if (extraPhones.length) {
    const extraLine = `Additional phones: ${extraPhones.join(", ")}`;
    notesAppend = notesAppend ? `${notesAppend}\n${extraLine}` : extraLine;
  }
  let notes = existingNotes || null;
  if (notesAppend) {
    if (!notes) notes = notesAppend;
    else if (!notes.includes(contact.contact_form_url || notesAppend)) notes = `${notes}\n${notesAppend}`;
  }
  return notes;
}

function applyScrapeContactToProspect(prospectId, contact) {
  contact = bindPhoneWhatsApp(contact);
  const existing = db.prepare("SELECT notes FROM prospects WHERE id=?").get(prospectId);
  const notes = buildNotesAppend(contact, existing?.notes);
  db.prepare(`
    UPDATE prospects SET
      email=COALESCE(?, email), phone=COALESCE(?, phone),
      linkedin=COALESCE(?, linkedin), instagram=COALESCE(?, instagram),
      facebook=COALESCE(?, facebook), whatsapp=COALESCE(?, whatsapp),
      twitter=COALESCE(?, twitter), notes=COALESCE(?, notes),
      scrape_status='done', updated_at=datetime('now')
    WHERE id=?
  `).run(
    contact.email ?? null, contact.phone ?? null, contact.linkedin ?? null, contact.instagram ?? null,
    contact.facebook ?? null, contact.whatsapp ?? null, contact.twitter ?? null, notes, prospectId,
  );
  contactSync.syncProspectToLinkedFinalProspects(prospectId);
}

function applyScrapeContact(finalProspectId, contact) {
  contact = bindPhoneWhatsApp(contact);
  const existing = db.prepare("SELECT notes, prospect_id FROM final_prospects WHERE id=?").get(finalProspectId);
  if (!existing) return null;

  const notes = buildNotesAppend(contact, existing.notes);
  db.prepare(`
    UPDATE final_prospects SET
      email=COALESCE(?, email), phone=COALESCE(?, phone),
      linkedin=COALESCE(?, linkedin), instagram=COALESCE(?, instagram),
      facebook=COALESCE(?, facebook), whatsapp=COALESCE(?, whatsapp),
      twitter=COALESCE(?, twitter), notes=COALESCE(?, notes),
      scrape_status='done', updated_at=datetime('now')
    WHERE id=?
  `).run(
    contact.email ?? null, contact.phone ?? null, contact.linkedin ?? null, contact.instagram ?? null,
    contact.facebook ?? null, contact.whatsapp ?? null, contact.twitter ?? null, notes, finalProspectId,
  );

  if (existing.prospect_id) {
    applyScrapeContactToProspect(existing.prospect_id, contact);
  } else {
    const fpRow = db.prepare("SELECT list_item_id FROM final_prospects WHERE id=?").get(finalProspectId);
    if (fpRow?.list_item_id) {
      contactSync.reconcileFinalProspectsForListItem(fpRow.list_item_id);
    }
    const linked = db.prepare("SELECT prospect_id FROM final_prospects WHERE id=?").get(finalProspectId);
    if (linked?.prospect_id) {
      contactSync.syncFinalProspectToLinkedProspect(finalProspectId);
    }
  }

  return db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
}

function updateFinalProspect(id, data) {
  data = bindPhoneWhatsApp(data);
  db.prepare(`
    UPDATE final_prospects SET
      name=COALESCE(?, name),
      website=COALESCE(?, website),
      email=COALESCE(?, email),
      phone=COALESCE(?, phone),
      linkedin=COALESCE(?, linkedin),
      instagram=COALESCE(?, instagram),
      facebook=COALESCE(?, facebook),
      whatsapp=COALESCE(?, whatsapp),
      twitter=COALESCE(?, twitter),
      notes=COALESCE(?, notes),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    data.name ?? null,
    data.website ?? null,
    data.email ?? null,
    data.phone ?? null,
    data.linkedin ?? null,
    data.instagram ?? null,
    data.facebook ?? null,
    data.whatsapp ?? null,
    data.twitter ?? null,
    data.notes ?? null,
    id,
  );
  contactSync.syncFinalProspectToLinkedProspect(id);
  return db.prepare("SELECT * FROM final_prospects WHERE id=?").get(id);
}

function deleteFinalProspect(id) {
  db.prepare("DELETE FROM final_prospects WHERE id=?").run(id);
  return { ok: true };
}

function toggleFromProcessingResult(listItemId, processingResultId, campaignDomainId = null) {
  const existing = findFinalByProcessingResult(listItemId, processingResultId);
  if (existing) {
    deleteFinalProspect(existing.id);
    return { ok: true, inFinal: false };
  }
  const out = addFromProcessingResult(listItemId, processingResultId, campaignDomainId);
  if (!out.ok) return out;
  return {
    ok: true,
    inFinal: true,
    duplicate: out.duplicate,
    finalProspect: out.finalProspect,
    warnings: out.warnings || [],
  };
}

function toggleFromProspect(campaignDomainId, prospectId) {
  const cd = db.prepare("SELECT * FROM campaign_domains WHERE id=?").get(campaignDomainId);
  if (!cd?.list_item_id) return { ok: false, error: "Campaign domain has no linked list item" };

  const existing = findFinalByProspect(cd.list_item_id, prospectId);
  if (existing) {
    deleteFinalProspect(existing.id);
    return { ok: true, inFinal: false };
  }
  const out = addFromProspect(campaignDomainId, prospectId);
  if (!out.ok) return out;
  return {
    ok: true,
    inFinal: true,
    duplicate: out.duplicate,
    finalProspect: out.finalProspect,
    warnings: out.warnings || [],
  };
}

function ensureMessageSlots(prospectId) {
  for (let slot = 0; slot < 5; slot += 1) {
    db.prepare(`
      INSERT INTO outreach_messages (prospect_id, slot)
      VALUES (?, ?)
      ON CONFLICT(prospect_id, slot) DO NOTHING
    `).run(prospectId, slot);
  }
}

function linkFinalProspectToCampaignProspect(finalProspectId, prospectId) {
  const prospect = db.prepare(
    "SELECT id, campaign_domain_id FROM prospects WHERE id=?"
  ).get(prospectId);
  if (!prospect) return { ok: false, error: "Prospect not found" };

  contactSync.bidirectionalMergeFinalAndProspect(finalProspectId, prospectId);

  db.prepare(`
    UPDATE final_prospects
    SET prospect_id=?, campaign_domain_id=COALESCE(campaign_domain_id, ?), updated_at=datetime('now')
    WHERE id=?
  `).run(prospectId, prospect.campaign_domain_id, finalProspectId);

  ensureMessageSlots(prospectId);
  contactSync.syncProspectToLinkedFinalProspects(prospectId);
  marketingAccounts.syncAssignmentsToProspect(finalProspectId, prospectId);
  messageTracking.syncTrackingProspectId(finalProspectId, prospectId);

  return { ok: true, prospectId };
}

function resolveCampaignDomainId(finalProspect) {
  if (finalProspect.campaign_domain_id) return finalProspect.campaign_domain_id;

  const byListItem = db.prepare(
    "SELECT id FROM campaign_domains WHERE list_item_id=? ORDER BY id LIMIT 1"
  ).get(finalProspect.list_item_id);
  if (byListItem) return byListItem.id;

  const listItem = db.prepare(
    "SELECT list_id, domain FROM domain_list_items WHERE id=?"
  ).get(finalProspect.list_item_id);

  if (listItem) {
    const byDomain = db.prepare(`
      SELECT cd.id FROM campaign_domains cd
      JOIN domain_list_items dli ON dli.id = cd.list_item_id
      WHERE dli.list_id = ? AND LOWER(dli.domain) = LOWER(?)
      ORDER BY cd.id
      LIMIT 1
    `).get(listItem.list_id, listItem.domain);
    if (byDomain) return byDomain.id;

    if (finalProspect.website) {
      const byWebsite = db.prepare(`
        SELECT p.campaign_domain_id FROM prospects p
        JOIN campaign_domains cd ON cd.id = p.campaign_domain_id
        JOIN domain_list_items dli ON dli.id = cd.list_item_id
        WHERE dli.list_id = ? AND p.website = ?
        LIMIT 1
      `).get(listItem.list_id, finalProspect.website);
      if (byWebsite?.campaign_domain_id) return byWebsite.campaign_domain_id;
    }
  }

  if (finalProspect.prospect_id) {
    const prospect = db.prepare(
      "SELECT campaign_domain_id FROM prospects WHERE id=?"
    ).get(finalProspect.prospect_id);
    if (prospect?.campaign_domain_id) return prospect.campaign_domain_id;
  }

  return null;
}

function findExistingProspectId(campaignDomainId, finalProspect) {
  if (finalProspect.prospect_id) {
    const linked = db.prepare("SELECT id FROM prospects WHERE id=?").get(finalProspect.prospect_id);
    if (linked) return linked.id;
  }

  if (finalProspect.website) {
    const existing = db.prepare(
      "SELECT id FROM prospects WHERE campaign_domain_id=? AND website=? LIMIT 1"
    ).get(campaignDomainId, finalProspect.website);
    if (existing) return existing.id;
  }

  const listItem = db.prepare(
    "SELECT list_id FROM domain_list_items WHERE id=?"
  ).get(finalProspect.list_item_id);

  if (listItem && finalProspect.website) {
    const existing = db.prepare(`
      SELECT p.id FROM prospects p
      JOIN campaign_domains cd ON cd.id = p.campaign_domain_id
      JOIN domain_list_items dli ON dli.id = cd.list_item_id
      WHERE dli.list_id = ? AND p.website = ?
      LIMIT 1
    `).get(listItem.list_id, finalProspect.website);
    if (existing) return existing.id;
  }

  return null;
}

function ensureProspectForFinal(finalProspectId, options = {}) {
  const fp = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
  if (!fp) return { ok: false, error: "Final prospect not found" };

  if (options.prospectId) {
    return linkFinalProspectToCampaignProspect(finalProspectId, options.prospectId);
  }

  const linkedProspectId = findLinkedProspectId(fp);
  if (linkedProspectId) {
    return linkFinalProspectToCampaignProspect(finalProspectId, linkedProspectId);
  }

  let campaignDomainId = options.campaignDomainId || resolveCampaignDomainId(fp);
  if (!campaignDomainId) {
    return { ok: false, error: "Add this domain to a campaign before starting outreach" };
  }

  let prospectId = findExistingProspectId(campaignDomainId, fp);

  if (!prospectId) {
    const info = db.prepare(`
      INSERT INTO prospects (
        campaign_domain_id, name, website, email, phone, linkedin, instagram,
        facebook, whatsapp, twitter, notes, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      campaignDomainId,
      fp.name ?? null,
      fp.website ?? null,
      fp.email ?? null,
      fp.phone ?? null,
      fp.linkedin ?? null,
      fp.instagram ?? null,
      fp.facebook ?? null,
      fp.whatsapp ?? null,
      fp.twitter ?? null,
      fp.notes ?? null,
      fp.source || "final",
    );
    prospectId = info.lastInsertRowid;
    ensureMessageSlots(prospectId);
  } else {
    const existingProspect = db.prepare(
      "SELECT campaign_domain_id FROM prospects WHERE id=?"
    ).get(prospectId);
    if (existingProspect?.campaign_domain_id) {
      campaignDomainId = existingProspect.campaign_domain_id;
    }
    contactSync.bidirectionalMergeFinalAndProspect(finalProspectId, prospectId);
  }

  db.prepare(`
    UPDATE final_prospects
    SET prospect_id=?, campaign_domain_id=COALESCE(campaign_domain_id, ?), updated_at=datetime('now')
    WHERE id=?
  `).run(prospectId, campaignDomainId, finalProspectId);

  contactSync.syncProspectToLinkedFinalProspects(prospectId);
  marketingAccounts.syncAssignmentsToProspect(finalProspectId, prospectId);
  messageTracking.syncTrackingProspectId(finalProspectId, prospectId);

  return { ok: true, prospectId };
}

module.exports = {
  getFinalProspectsByListItem,
  getFinalProspectsByCampaignDomain,
  addFromProcessingResult,
  addFromProspect,
  toggleFromProcessingResult,
  toggleFromProspect,
  updateFinalProspect,
  deleteFinalProspect,
  ensureProspectForFinal,
  applyScrapeContact,
  applyScrapeContactToProspect,
};
