const { db, transaction } = require("../db");

const AUTO_SOURCES = ["google_exact", "google_partial", "google_serp", "zfbot", "linkedin", "instagram", "crunchbase"];

function prospectFromResult(r) {
  let website = null;
  let name = null;
  let source = r.step;

  if (r.step === "google_serp" && r.match_type === "exact") {
    website = r.url || (r.result_domain ? `https://${r.result_domain}` : null);
    name = r.title || r.result_domain;
    source = "google_exact";
  } else if (r.step === "google_serp" && r.match_type === "partial") {
    website = r.url || (r.result_domain ? `https://${r.result_domain}` : null);
    name = r.title || r.result_domain;
    source = "google_partial";
  } else if (r.step === "zfbot" && r.result_domain) {
    website = r.url || `https://${r.result_domain}`;
    name = r.title || r.result_domain;
  } else if (["linkedin", "instagram", "crunchbase"].includes(r.step) && r.url) {
    website = r.url;
    name = r.title || r.result_domain || r.url;
  } else {
    return null;
  }
  if (!website) return null;

  return {
    website,
    name,
    source,
    linkedin: source === "linkedin" ? website : null,
    instagram: source === "instagram" ? website : null,
  };
}

function insertProspect(campaignDomainId, fields) {
  const info = db.prepare(`
    INSERT INTO prospects (campaign_domain_id, name, website, linkedin, instagram, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    campaignDomainId,
    fields.name,
    fields.website,
    fields.linkedin,
    fields.instagram,
    fields.source
  );
  for (let slot = 0; slot < 5; slot++) {
    db.prepare("INSERT INTO outreach_messages (prospect_id, slot) VALUES (?, ?)")
      .run(info.lastInsertRowid, slot);
  }
  return info.lastInsertRowid;
}

function syncProspectsForCampaignDomain(campaignDomainId, listItemId, mode = "merge") {
  const results = db.prepare(`
    SELECT result_domain, title, url, step, match_type
    FROM processing_results WHERE list_item_id=?
  `).all(listItemId);

  const findExistingByWebsite = db.prepare(
    "SELECT id FROM prospects WHERE campaign_domain_id=? AND website=?"
  );
  const delAuto = db.prepare(`
    DELETE FROM prospects
    WHERE campaign_domain_id=? AND source IN (${AUTO_SOURCES.map(() => "?").join(", ")})
  `);

  let added = 0;
  let removed = 0;

  transaction(() => {
    if (mode === "overwrite") {
      removed = delAuto.run(campaignDomainId, ...AUTO_SOURCES).changes;
    }

    for (const r of results) {
      const fields = prospectFromResult(r);
      if (!fields) continue;

      if (mode === "merge" && findExistingByWebsite.get(campaignDomainId, fields.website)) {
        continue;
      }

      insertProspect(campaignDomainId, fields);
      added++;
    }
  });

  return { added, removed };
}

function syncProspectsForListItem(listItemId, mode = "merge") {
  const campaignDomains = db.prepare(
    "SELECT id FROM campaign_domains WHERE list_item_id=?"
  ).all(listItemId);
  if (!campaignDomains.length) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const cd of campaignDomains) {
    const stats = syncProspectsForCampaignDomain(cd.id, listItemId, mode);
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

module.exports = {
  AUTO_SOURCES,
  prospectFromResult,
  syncProspectsForCampaignDomain,
  syncProspectsForListItem,
};
