const { db } = require("../db");

function normalizeWebsite(url) {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`);
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/$/, "");
  }
}

function findLinkedProspectId(finalProspect) {
  if (finalProspect.prospect_id) {
    const linked = db.prepare("SELECT id FROM prospects WHERE id=?").get(finalProspect.prospect_id);
    if (linked) return linked.id;
  }

  if (finalProspect.website) {
    const exact = db.prepare(
      "SELECT id FROM prospects WHERE website=? ORDER BY id DESC LIMIT 1"
    ).get(finalProspect.website);
    if (exact) return exact.id;

    const normalized = normalizeWebsite(finalProspect.website);
    if (normalized) {
      const candidates = db.prepare(
        "SELECT id, website FROM prospects WHERE website IS NOT NULL ORDER BY id DESC"
      ).all();
      const match = candidates.find((p) => normalizeWebsite(p.website) === normalized);
      if (match) return match.id;
    }
  }

  if (finalProspect.email?.trim()) {
    const byEmail = db.prepare(`
      SELECT id FROM prospects
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
      ORDER BY id DESC LIMIT 1
    `).get(finalProspect.email);
    if (byEmail) return byEmail.id;
  }

  const listItem = db.prepare(
    "SELECT list_id FROM domain_list_items WHERE id=?"
  ).get(finalProspect.list_item_id);

  if (listItem && finalProspect.website) {
    const byListWebsite = db.prepare(`
      SELECT p.id FROM prospects p
      JOIN campaign_domains cd ON cd.id = p.campaign_domain_id
      JOIN domain_list_items dli ON dli.id = cd.list_item_id
      WHERE dli.list_id = ? AND p.website = ?
      LIMIT 1
    `).get(listItem.list_id, finalProspect.website);
    if (byListWebsite) return byListWebsite.id;
  }

  return null;
}

module.exports = { findLinkedProspectId, normalizeWebsite };
