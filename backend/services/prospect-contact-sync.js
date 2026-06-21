const { db } = require("../db");
const { bindPhoneWhatsApp } = require("./phone-whatsapp");

const CONTACT_FIELDS = [
  "name", "website", "email", "phone", "linkedin", "instagram",
  "facebook", "whatsapp", "twitter", "notes", "scrape_status",
];

function normalizeWebsite(url) {
  if (!url) return "";
  let s = String(url).trim().toLowerCase();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "") || "";
    return path ? `${host}${path}` : host;
  } catch {
    return s
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }
}

function normalizeDomain(domain) {
  if (!domain) return "";
  return String(domain).trim().toLowerCase().replace(/^www\./, "");
}

function pickContactFields(row) {
  if (!row) return {};
  const out = {};
  for (const key of CONTACT_FIELDS) {
    if (row[key] != null && row[key] !== "") out[key] = row[key];
  }
  return out;
}

function syncContactFromProspectToFinalRow(finalProspectId, prospect) {
  if (!prospect) return;
  db.prepare(`
    UPDATE final_prospects SET
      name=?, website=?, email=?, phone=?,
      linkedin=?, instagram=?, facebook=?, whatsapp=?, twitter=?,
      notes=?, scrape_status=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    prospect.name ?? null,
    prospect.website ?? null,
    prospect.email ?? null,
    prospect.phone ?? null,
    prospect.linkedin ?? null,
    prospect.instagram ?? null,
    prospect.facebook ?? null,
    prospect.whatsapp ?? null,
    prospect.twitter ?? null,
    prospect.notes ?? null,
    prospect.scrape_status ?? null,
    finalProspectId,
  );
}

function syncContactFromFinalToProspectRow(prospectId, finalProspect) {
  if (!finalProspect) return;
  db.prepare(`
    UPDATE prospects SET
      name=?, website=?, email=?, phone=?,
      linkedin=?, instagram=?, facebook=?, whatsapp=?, twitter=?,
      notes=?, scrape_status=COALESCE(?, scrape_status), updated_at=datetime('now')
    WHERE id=?
  `).run(
    finalProspect.name ?? null,
    finalProspect.website ?? null,
    finalProspect.email ?? null,
    finalProspect.phone ?? null,
    finalProspect.linkedin ?? null,
    finalProspect.instagram ?? null,
    finalProspect.facebook ?? null,
    finalProspect.whatsapp ?? null,
    finalProspect.twitter ?? null,
    finalProspect.notes ?? null,
    finalProspect.scrape_status ?? null,
    prospectId,
  );
}

function mergeContactIntoProspect(prospectId, patch) {
  patch = bindPhoneWhatsApp(patch);
  const existing = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospectId);
  if (!existing) return;
  db.prepare(`
    UPDATE prospects SET
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
      scrape_status=COALESCE(?, scrape_status),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    patch.name ?? null,
    patch.website ?? null,
    patch.email ?? null,
    patch.phone ?? null,
    patch.linkedin ?? null,
    patch.instagram ?? null,
    patch.facebook ?? null,
    patch.whatsapp ?? null,
    patch.twitter ?? null,
    patch.notes ?? null,
    patch.scrape_status ?? null,
    prospectId,
  );
}

function mergeContactIntoFinal(finalProspectId, patch) {
  patch = bindPhoneWhatsApp(patch);
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
      scrape_status=COALESCE(?, scrape_status),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    patch.name ?? null,
    patch.website ?? null,
    patch.email ?? null,
    patch.phone ?? null,
    patch.linkedin ?? null,
    patch.instagram ?? null,
    patch.facebook ?? null,
    patch.whatsapp ?? null,
    patch.twitter ?? null,
    patch.notes ?? null,
    patch.scrape_status ?? null,
    finalProspectId,
  );
}

function syncProspectToLinkedFinalProspects(prospectId) {
  const prospect = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospectId);
  if (!prospect) return;
  const finals = db.prepare("SELECT id FROM final_prospects WHERE prospect_id=?").all(prospectId);
  for (const fp of finals) {
    syncContactFromProspectToFinalRow(fp.id, prospect);
  }
}

function syncFinalProspectToLinkedProspect(finalProspectId) {
  const fp = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
  if (!fp?.prospect_id) return;
  syncContactFromFinalToProspectRow(fp.prospect_id, fp);
}

function resolveCampaignDomainIdForFinal(finalProspect) {
  if (finalProspect.campaign_domain_id) return finalProspect.campaign_domain_id;
  const cd = db.prepare(
    "SELECT id FROM campaign_domains WHERE list_item_id=? ORDER BY id LIMIT 1"
  ).get(finalProspect.list_item_id);
  return cd?.id ?? null;
}

function buildProspectLookup(campaignDomainId) {
  const prospects = db.prepare(
    "SELECT * FROM prospects WHERE campaign_domain_id=?"
  ).all(campaignDomainId);

  const byWebsite = new Map();
  const byDomain = new Map();

  for (const p of prospects) {
    const webKey = normalizeWebsite(p.website);
    if (webKey && !byWebsite.has(webKey)) byWebsite.set(webKey, p);

    const domKey = normalizeDomain(normalizeWebsite(p.website).split("/")[0]);
    if (domKey && !byDomain.has(domKey)) byDomain.set(domKey, p);

    for (const field of ["linkedin", "instagram", "facebook"]) {
      const key = normalizeWebsite(p[field]);
      if (key && !byWebsite.has(key)) byWebsite.set(key, p);
    }
  }

  return { byWebsite, byDomain };
}

function findMatchingProspect(finalProspect, lookup) {
  if (!lookup) return null;

  const keys = new Set();
  if (finalProspect.website) keys.add(normalizeWebsite(finalProspect.website));
  if (finalProspect.url) keys.add(normalizeWebsite(finalProspect.url));
  if (finalProspect.linkedin) keys.add(normalizeWebsite(finalProspect.linkedin));
  if (finalProspect.instagram) keys.add(normalizeWebsite(finalProspect.instagram));

  for (const key of keys) {
    if (key && lookup.byWebsite.has(key)) return lookup.byWebsite.get(key);
  }

  const domains = new Set();
  if (finalProspect.result_domain) domains.add(normalizeDomain(finalProspect.result_domain));
  for (const key of keys) {
    const host = key.split("/")[0];
    if (host) domains.add(normalizeDomain(host));
  }

  for (const dom of domains) {
    if (dom && lookup.byDomain.has(dom)) return lookup.byDomain.get(dom);
  }

  return null;
}

function mergeOrphanIntoExisting(orphanId, existingId) {
  const orphan = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(orphanId);
  if (!orphan || orphanId === existingId) return existingId;

  mergeContactIntoFinal(existingId, pickContactFields(orphan));

  if (orphan.processing_result_id) {
    db.prepare(`
      UPDATE final_prospects
      SET processing_result_id=COALESCE(processing_result_id, ?),
          prospect_id=COALESCE(prospect_id, ?),
          campaign_domain_id=COALESCE(campaign_domain_id, ?),
          updated_at=datetime('now')
      WHERE id=?
    `).run(
      orphan.processing_result_id,
      orphan.prospect_id,
      orphan.campaign_domain_id,
      existingId,
    );
  }

  const orphanAssignment = db.prepare(
    "SELECT marketing_account_id FROM final_prospect_account_assignments WHERE final_prospect_id=?"
  ).get(orphanId);

  if (orphanAssignment) {
    db.prepare(`
      INSERT INTO final_prospect_account_assignments (final_prospect_id, marketing_account_id)
      VALUES (?, ?)
      ON CONFLICT(final_prospect_id) DO NOTHING
    `).run(existingId, orphanAssignment.marketing_account_id);
  }

  db.prepare("DELETE FROM final_prospect_account_assignments WHERE final_prospect_id=?").run(orphanId);
  db.prepare("DELETE FROM final_prospects WHERE id=?").run(orphanId);
  return existingId;
}

function linkFinalProspectToProspect(finalProspectId, prospect, campaignDomainId) {
  const fp = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
  if (!fp) return finalProspectId;

  const existing = db.prepare(
    "SELECT id FROM final_prospects WHERE list_item_id=? AND prospect_id=? AND id!=?"
  ).get(fp.list_item_id, prospect.id, finalProspectId);

  if (existing) {
    const mergedId = mergeOrphanIntoExisting(finalProspectId, existing.id);
    const mergedProspect = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospect.id);
    syncContactFromProspectToFinalRow(mergedId, mergedProspect);
    return mergedId;
  }

  db.prepare(`
    UPDATE final_prospects
    SET prospect_id=?, campaign_domain_id=COALESCE(campaign_domain_id, ?), updated_at=datetime('now')
    WHERE id=?
  `).run(prospect.id, campaignDomainId, finalProspectId);

  const finalRow = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
  mergeContactIntoProspect(prospect.id, pickContactFields(finalRow));
  const merged = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospect.id);
  syncContactFromProspectToFinalRow(finalProspectId, merged);
  return finalProspectId;
}

function linkOrphanFinalProspectsByWebsite(listItemId) {
  const orphans = db.prepare(`
    SELECT *
    FROM final_prospects
    WHERE list_item_id=? AND prospect_id IS NULL
  `).all(listItemId);

  const lookupCache = new Map();

  for (const fp of orphans) {
    const campaignDomainId = resolveCampaignDomainIdForFinal(fp);
    if (!campaignDomainId) continue;

    if (!lookupCache.has(campaignDomainId)) {
      lookupCache.set(campaignDomainId, buildProspectLookup(campaignDomainId));
    }

    const match = findMatchingProspect(fp, lookupCache.get(campaignDomainId));
    if (!match) continue;

    linkFinalProspectToProspect(fp.id, match, campaignDomainId);
  }
}

function reconcileFinalProspectsForListItem(listItemId) {
  linkOrphanFinalProspectsByWebsite(listItemId);

  const linked = db.prepare(`
    SELECT fp.id, fp.prospect_id
    FROM final_prospects fp
    WHERE fp.list_item_id=? AND fp.prospect_id IS NOT NULL
  `).all(listItemId);

  for (const row of linked) {
    const prospect = db.prepare("SELECT * FROM prospects WHERE id=?").get(row.prospect_id);
    if (prospect) syncContactFromProspectToFinalRow(row.id, prospect);
  }
}

function bidirectionalMergeFinalAndProspect(finalProspectId, prospectId) {
  const fp = db.prepare("SELECT * FROM final_prospects WHERE id=?").get(finalProspectId);
  const prospect = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospectId);
  if (!fp || !prospect) return;

  mergeContactIntoProspect(prospectId, pickContactFields(fp));
  const merged = db.prepare("SELECT * FROM prospects WHERE id=?").get(prospectId);
  syncContactFromProspectToFinalRow(finalProspectId, merged);
}

module.exports = {
  CONTACT_FIELDS,
  normalizeWebsite,
  pickContactFields,
  syncContactFromProspectToFinalRow,
  syncContactFromFinalToProspectRow,
  mergeContactIntoProspect,
  mergeContactIntoFinal,
  syncProspectToLinkedFinalProspects,
  syncFinalProspectToLinkedProspect,
  linkOrphanFinalProspectsByWebsite,
  reconcileFinalProspectsForListItem,
  bidirectionalMergeFinalAndProspect,
};
