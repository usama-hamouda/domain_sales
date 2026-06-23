const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

function loadEnvFile() {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`[env] Loaded ${envPath}`);
    break;
  }
}
loadEnvFile();

const { db, today, tryParse, transaction } = require("./db");
const processor = require("./services/processor-queue");
const { syncProspectsForCampaignDomain } = require("./services/prospect-sync");
const finalProspects = require("./services/final-prospects");
const marketingAccounts = require("./services/marketing-accounts");
const messageTracking = require("./services/message-tracking");
const contactSync = require("./services/prospect-contact-sync");
const { bindPhoneWhatsApp } = require("./services/phone-whatsapp");
const remoteDbSync = require("./services/remote-db-sync");
const syncApply = require("./services/sync-apply");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(remoteDbSync.middleware());
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "domain-sales",
    port: PORT,
    remoteDbSync: remoteDbSync.getStatus(),
    syncReceiver: syncApply.isReceiverEnabled(),
  });
});

app.get("/api/sync/status", (req, res) => {
  const status = remoteDbSync.getStatus();
  if (syncApply.isReceiverEnabled()) {
    status.syncReceiver = true;
    status.receiverOutbox = 0;
  }
  res.json(status);
});

app.post("/api/sync/apply", syncApply.authMiddleware, (req, res) => {
  try {
    const batch = req.body?.batch;
    if (!Array.isArray(batch)) {
      return res.status(400).json({ error: "batch array required" });
    }
    const result = syncApply.applyBatch(db, batch);
    res.json(result);
  } catch (e) {
    console.error("POST /api/sync/apply:", e);
    res.status(500).json({ error: e.message || "Failed to apply sync batch" });
  }
});

app.post("/api/sync/push", async (req, res) => {
  const out = await remoteDbSync.syncNow();
  if (!out.ok) return res.status(out.error?.includes("not configured") ? 400 : 500).json(out);
  res.json(out);
});

// ─── Domain Lists ───────────────────────────────────────────

app.get("/api/lists", (req, res) => {
  const rows = db.prepare(`
    SELECT dl.*, COUNT(dli.id) AS item_count
    FROM domain_lists dl
    LEFT JOIN domain_list_items dli ON dli.list_id = dl.id
    GROUP BY dl.id
    ORDER BY dl.list_date DESC, dl.created_at DESC
  `).all();
  res.json(rows);
});

app.get("/api/lists/:id", (req, res) => {
  const list = db.prepare("SELECT * FROM domain_lists WHERE id=?").get(req.params.id);
  if (!list) return res.status(404).json({ error: "List not found" });
  const items = db.prepare(`
    SELECT dli.*, COALESCE(fp.final_prospects_count, 0) AS final_prospects_count
    FROM domain_list_items dli
    LEFT JOIN (
      SELECT list_item_id, COUNT(*) AS final_prospects_count
      FROM final_prospects
      GROUP BY list_item_id
    ) fp ON fp.list_item_id = dli.id
    WHERE dli.list_id=?
    ORDER BY dli.position
  `).all(req.params.id);
  res.json({
    ...list,
    col_order: tryParse(list.col_order, []),
    items: items.map((i) => ({
      ...i,
      row_data: tryParse(i.row_data, {}),
      selected: !!i.selected,
      final_prospects_count: Number(i.final_prospects_count) || 0,
    })),
  });
});

app.post("/api/lists", (req, res) => {
  try {
    const { name, list_date = today(), col_order = [], items = [], notes } = req.body;
    const listName = name || `List ${list_date}`;

    const validItems = items
      .map((item) => ({
        domain: String(item.domain || item.Domain || "").trim(),
        row_data: item.row_data || item,
      }))
      .filter((item) => item.domain && item.domain.includes("."));

    if (!validItems.length) {
      return res.status(400).json({ error: "No valid domains in import" });
    }

    const insertItem = db.prepare(`
      INSERT INTO domain_list_items (list_id, domain, position, row_data)
      VALUES (?, ?, ?, ?)
    `);

    const listId = transaction(() => {
      const info = db.prepare(
        "INSERT INTO domain_lists (name, list_date, col_order, notes) VALUES (?, ?, ?, ?)"
      ).run(listName, list_date, JSON.stringify(col_order), notes || null);
      const id = info.lastInsertRowid;
      validItems.forEach((item, pos) => {
        insertItem.run(id, item.domain, pos, JSON.stringify(item.row_data));
      });
      db.prepare("UPDATE domain_lists SET updated_at=datetime('now') WHERE id=?").run(id);
      return id;
    });

    res.json(db.prepare("SELECT * FROM domain_lists WHERE id=?").get(listId));
  } catch (e) {
    console.error("POST /api/lists:", e);
    res.status(500).json({ error: e.message || "Failed to save list" });
  }
});

app.patch("/api/lists/:id", (req, res) => {
  const { name, notes, col_order } = req.body;
  db.prepare(`
    UPDATE domain_lists SET
      name=COALESCE(?, name),
      notes=COALESCE(?, notes),
      col_order=COALESCE(?, col_order),
      updated_at=datetime('now')
    WHERE id=?
  `).run(name ?? null, notes ?? null, col_order ? JSON.stringify(col_order) : null, req.params.id);
  res.json(db.prepare("SELECT * FROM domain_lists WHERE id=?").get(req.params.id));
});

app.delete("/api/lists/:id", (req, res) => {
  db.prepare("DELETE FROM domain_lists WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.patch("/api/lists/:listId/items/selection", (req, res) => {
  const { itemIds = [], selected } = req.body;
  const val = selected ? 1 : 0;
  const stmt = db.prepare("UPDATE domain_list_items SET selected=? WHERE id=? AND list_id=?");
  transaction(() => {
    for (const id of itemIds) stmt.run(val, id, req.params.listId);
  });
  res.json({ ok: true });
});

app.post("/api/lists/:listId/items/select-all", (req, res) => {
  const { selected = true } = req.body;
  db.prepare("UPDATE domain_list_items SET selected=? WHERE list_id=?").run(selected ? 1 : 0, req.params.listId);
  res.json({ ok: true });
});

app.get("/api/lists/:listId/items/:itemId/results", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM processing_results WHERE list_item_id=? ORDER BY step, match_type"
  ).all(req.params.itemId);
  res.json(rows.map((r) => ({ ...r, extra: tryParse(r.extra, null) })));
});

// ─── Final prospects (curated list) ───────────────────────

app.get("/api/lists/:listId/items/:itemId/final-prospects", (req, res) => {
  const item = db.prepare("SELECT id FROM domain_list_items WHERE id=? AND list_id=?")
    .get(req.params.itemId, req.params.listId);
  if (!item) return res.status(404).json({ error: "List item not found" });
  res.json(finalProspects.getFinalProspectsByListItem(req.params.itemId));
});

app.post("/api/lists/:listId/items/:itemId/final-prospects", (req, res) => {
  const item = db.prepare("SELECT id FROM domain_list_items WHERE id=? AND list_id=?")
    .get(req.params.itemId, req.params.listId);
  if (!item) return res.status(404).json({ error: "List item not found" });
  const { processingResultId } = req.body;
  if (!processingResultId) return res.status(400).json({ error: "processingResultId required" });
  const out = finalProspects.addFromProcessingResult(req.params.itemId, Number(processingResultId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/lists/:listId/items/:itemId/final-prospects/toggle", (req, res) => {
  const item = db.prepare("SELECT id FROM domain_list_items WHERE id=? AND list_id=?")
    .get(req.params.itemId, req.params.listId);
  if (!item) return res.status(404).json({ error: "List item not found" });
  const { processingResultId } = req.body;
  if (!processingResultId) return res.status(400).json({ error: "processingResultId required" });
  const out = finalProspects.toggleFromProcessingResult(req.params.itemId, Number(processingResultId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.get("/api/campaign-domains/:id/final-prospects", (req, res) => {
  const cd = db.prepare("SELECT id FROM campaign_domains WHERE id=?").get(req.params.id);
  if (!cd) return res.status(404).json({ error: "Not found" });
  res.json(finalProspects.getFinalProspectsByCampaignDomain(req.params.id));
});

app.get("/api/campaign-domains/:id/processing-results", (req, res) => {
  const cd = db.prepare("SELECT list_item_id FROM campaign_domains WHERE id=?").get(req.params.id);
  if (!cd) return res.status(404).json({ error: "Not found" });
  if (!cd.list_item_id) return res.json([]);
  const rows = db.prepare(
    "SELECT * FROM processing_results WHERE list_item_id=? ORDER BY step, match_type"
  ).all(cd.list_item_id);
  res.json(rows.map((r) => ({ ...r, extra: tryParse(r.extra, null) })));
});

app.post("/api/campaign-domains/:id/final-prospects/from-result", (req, res) => {
  const cd = db.prepare("SELECT id, list_item_id FROM campaign_domains WHERE id=?").get(req.params.id);
  if (!cd?.list_item_id) return res.status(400).json({ error: "No linked list item" });
  const { processingResultId } = req.body;
  if (!processingResultId) return res.status(400).json({ error: "processingResultId required" });
  const out = finalProspects.addFromProcessingResult(
    cd.list_item_id,
    Number(processingResultId),
    Number(req.params.id)
  );
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/campaign-domains/:id/final-prospects/from-prospect", (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) return res.status(400).json({ error: "prospectId required" });
  const out = finalProspects.addFromProspect(Number(req.params.id), Number(prospectId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/campaign-domains/:id/final-prospects/toggle-result", (req, res) => {
  const cd = db.prepare("SELECT id, list_item_id FROM campaign_domains WHERE id=?").get(req.params.id);
  if (!cd?.list_item_id) return res.status(400).json({ error: "No linked list item" });
  const { processingResultId } = req.body;
  if (!processingResultId) return res.status(400).json({ error: "processingResultId required" });
  const out = finalProspects.toggleFromProcessingResult(
    cd.list_item_id,
    Number(processingResultId),
    Number(req.params.id)
  );
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/campaign-domains/:id/final-prospects/toggle-prospect", (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) return res.status(400).json({ error: "prospectId required" });
  const out = finalProspects.toggleFromProspect(Number(req.params.id), Number(prospectId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/final-prospects/:id/ensure-prospect", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const out = finalProspects.ensureProspectForFinal(Number(req.params.id), {
    campaignDomainId: req.body?.campaignDomainId ? Number(req.body.campaignDomainId) : null,
    prospectId: req.body?.prospectId ? Number(req.body.prospectId) : null,
  });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.patch("/api/final-prospects/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const updated = finalProspects.updateFinalProspect(req.params.id, req.body);
  res.json(marketingAccounts.enrichFinalProspectsWithAccounts([updated])[0]);
});

app.delete("/api/final-prospects/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(finalProspects.deleteFinalProspect(req.params.id));
});

app.get("/api/final-prospects/:id/message-tracking", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(messageTracking.getMessageTrackingSummary(Number(req.params.id)));
});

app.patch("/api/final-prospects/:id/message-tracking", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const out = messageTracking.updateTracking(Number(req.params.id), req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out.tracking);
});

app.post("/api/final-prospects/:id/message-tracking/reset-dates", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const { startDate } = req.body;
  const out = messageTracking.resetStartDate(Number(req.params.id), startDate);
  if (!out.ok) return res.status(400).json(out);
  res.json(out.tracking);
});

app.post("/api/final-prospects/:id/message-tracking/reset-status", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const out = messageTracking.resetMessageStatus(Number(req.params.id));
  res.json(out.tracking);
});

app.post("/api/final-prospects/:id/assign-account", (req, res) => {
  const row = db.prepare("SELECT id FROM final_prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const { marketingAccountId } = req.body;
  if (!marketingAccountId) return res.status(400).json({ error: "marketingAccountId required" });
  const out = marketingAccounts.setMarketingAccountForFinalProspect(Number(req.params.id), Number(marketingAccountId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/prospects/:id/assign-account", (req, res) => {
  const row = db.prepare("SELECT id FROM prospects WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const { marketingAccountId } = req.body;
  if (!marketingAccountId) return res.status(400).json({ error: "marketingAccountId required" });
  const out = marketingAccounts.setMarketingAccountForProspect(Number(req.params.id), Number(marketingAccountId));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// ─── Marketing accounts ─────────────────────────────────────

app.get("/api/marketing-accounts/settings", (req, res) => {
  res.json(marketingAccounts.getSettings());
});

app.patch("/api/marketing-accounts/settings", (req, res) => {
  const { maxProspectsPerAccount, followUpIntervalDays } = req.body;
  if (maxProspectsPerAccount === undefined && followUpIntervalDays === undefined) {
    return res.status(400).json({ error: "maxProspectsPerAccount or followUpIntervalDays required" });
  }
  if (maxProspectsPerAccount !== undefined) {
    const out = marketingAccounts.setMaxProspectsPerAccount(maxProspectsPerAccount);
    if (!out.ok) return res.status(400).json(out);
  }
  if (followUpIntervalDays !== undefined) {
    const out = messageTracking.setDefaultFollowUpInterval(followUpIntervalDays);
    if (!out.ok) return res.status(400).json(out);
  }
  res.json(marketingAccounts.getSettings());
});

app.get("/api/marketing-accounts/channels", (req, res) => {
  res.json({
    channels: marketingAccounts.ASSIGNMENT_CHANNELS,
    labels: marketingAccounts.CHANNEL_LABELS,
  });
});

app.get("/api/marketing-accounts", (req, res) => {
  res.json(marketingAccounts.listAccounts());
});

app.post("/api/marketing-accounts", (req, res) => {
  const out = marketingAccounts.createAccount(req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out.account);
});

app.get("/api/marketing-accounts/:id", (req, res) => {
  const account = marketingAccounts.getAccount(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(account);
});

app.patch("/api/marketing-accounts/:id", (req, res) => {
  const out = marketingAccounts.updateAccount(Number(req.params.id), req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out.account);
});

app.delete("/api/marketing-accounts/:id", (req, res) => {
  const out = marketingAccounts.deleteAccount(Number(req.params.id));
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.get("/api/marketing-accounts/:id/prospects", (req, res) => {
  const account = marketingAccounts.getAccount(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(marketingAccounts.listProspectsForAccount(Number(req.params.id)));
});

// ─── Campaigns ────────────────────────────────────────────

app.get("/api/campaigns", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(cd.id) AS domain_count
    FROM campaigns c
    LEFT JOIN campaign_domains cd ON cd.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all();
  res.json(rows);
});

app.post("/api/campaigns", (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const info = db.prepare("INSERT INTO campaigns (name, description) VALUES (?, ?)").run(name, description || null);
  res.json(db.prepare("SELECT * FROM campaigns WHERE id=?").get(info.lastInsertRowid));
});

app.get("/api/campaigns/:id", (req, res) => {
  const camp = db.prepare("SELECT * FROM campaigns WHERE id=?").get(req.params.id);
  if (!camp) return res.status(404).json({ error: "Not found" });
  const domains = db.prepare("SELECT * FROM campaign_domains WHERE campaign_id=? ORDER BY position").all(req.params.id);
  res.json({
    ...camp,
    domains: domains.map((d) => ({ ...d, row_data: tryParse(d.row_data, {}) })),
  });
});

app.post("/api/campaigns/:id/domains", (req, res) => {
  const { itemIds = [], campaignId, createNew, newCampaignName } = req.body;
  let targetId = req.params.id;

  if (createNew && newCampaignName) {
    const info = db.prepare("INSERT INTO campaigns (name) VALUES (?)").run(newCampaignName);
    targetId = info.lastInsertRowid;
  }

  const items = db.prepare(`
    SELECT * FROM domain_list_items WHERE id IN (${itemIds.map(() => "?").join(",") || "NULL"})
  `).all(...itemIds);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO campaign_domains
      (campaign_id, domain, list_item_id, row_data, position,
       google_exact, google_partial, linkedin_exact, instagram_exact, zfbot_count, crunchbase_exact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  transaction(() => {
    items.forEach((item, pos) => {
      ins.run(
        targetId, item.domain, item.id, item.row_data, pos,
        item.google_exact, item.google_partial, item.linkedin_exact,
        item.instagram_exact, item.zfbot_count, item.crunchbase_exact
      );
    });
    db.prepare("UPDATE campaigns SET updated_at=datetime('now') WHERE id=?").run(targetId);
  });
  res.json({ ok: true, campaignId: targetId, added: items.length });
});

app.delete("/api/campaigns/:campId/domains/:domainId", (req, res) => {
  db.prepare("DELETE FROM campaign_domains WHERE id=? AND campaign_id=?").run(req.params.domainId, req.params.campId);
  res.json({ ok: true });
});

// ─── Processing ─────────────────────────────────────────────

app.get("/api/processing/status", (req, res) => {
  res.json(processor.getState());
});

app.post("/api/processing/start", (req, res) => {
  const { listId, mode, selectedIds, resultsMode, googleStrategy, googleWaitMin } = req.body;
  res.json(processor.startProcessing({
    listId,
    mode,
    selectedIds,
    resultsMode,
    googleStrategy,
    googleWaitMin,
  }));
});

app.post("/api/processing/pause", (req, res) => {
  res.json(processor.pauseProcessing());
});

app.post("/api/processing/resume", (req, res) => {
  res.json(processor.resumeProcessing());
});

app.post("/api/processing/stop", (req, res) => {
  res.json(processor.stopProcessing());
});

app.post("/api/processing/scrape-contact", async (req, res) => {
  const { url, prospectId, finalProspectId, visible = true } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    send({ type: "progress", message: "Starting contact scrape…", phase: "init" });
    const out = await processor.runPythonWithProgress(
      "contact_scrape",
      { url, visible: visible !== false },
      (p) => send(p),
    );

    if (out.contact && (finalProspectId || prospectId)) {
      send({ type: "progress", message: "Saving enriched fields…", phase: "save" });
      if (finalProspectId) {
        finalProspects.applyScrapeContact(Number(finalProspectId), out.contact);
      } else if (prospectId) {
        finalProspects.applyScrapeContactToProspect(Number(prospectId), out.contact);
      }
    }

    send({
      type: "done",
      ok: out.ok !== false,
      contact: out.contact,
      fields_found: out.fields_found,
      pages_checked: out.pages_checked,
      enriched: out.enriched || [],
    });
  } catch (e) {
    send({ type: "error", error: e.message || "Scrape failed" });
  }
  res.end();
});

// ─── Prospects ──────────────────────────────────────────────

app.get("/api/campaign-domains/:id/prospects", (req, res) => {
  const rows = db.prepare("SELECT * FROM prospects WHERE campaign_domain_id=? ORDER BY id").all(req.params.id);
  res.json(rows.map((p) => {
    const fp = db.prepare("SELECT id FROM final_prospects WHERE prospect_id=?").get(p.id);
    return {
      ...p,
      final_prospect_id: fp?.id || null,
      account_assignments: marketingAccounts.getAssignmentsForProspect(p.id),
    };
  }));
});

function toDbVal(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  try { return JSON.stringify(v); } catch { return null; }
}

app.post("/api/campaign-domains/:id/prospects", (req, res) => {
  try {
    const d = bindPhoneWhatsApp(req.body || {});
    const info = db.prepare(`
      INSERT INTO prospects (campaign_domain_id, name, website, email, phone, linkedin, instagram, facebook, whatsapp, twitter, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      toDbVal(d.name),
      toDbVal(d.website),
      toDbVal(d.email),
      toDbVal(d.phone),
      toDbVal(d.linkedin),
      toDbVal(d.instagram),
      toDbVal(d.facebook),
      toDbVal(d.whatsapp),
      toDbVal(d.twitter),
      toDbVal(d.notes),
      d.source || "manual",
    );
    for (let slot = 0; slot < 5; slot++) {
      db.prepare("INSERT INTO outreach_messages (prospect_id, slot) VALUES (?, ?)").run(info.lastInsertRowid, slot);
    }
    const cd = db.prepare("SELECT list_item_id FROM campaign_domains WHERE id=?").get(req.params.id);
    if (cd?.list_item_id) {
      contactSync.reconcileFinalProspectsForListItem(cd.list_item_id);
    }
    res.json(db.prepare("SELECT * FROM prospects WHERE id=?").get(info.lastInsertRowid));
  } catch (e) {
    console.error("POST /api/campaign-domains/:id/prospects:", e);
    res.status(500).json({ error: e.message || "Failed to create prospect" });
  }
});

app.patch("/api/prospects/:id", (req, res) => {
  const d = bindPhoneWhatsApp(req.body || {});
  db.prepare(`
    UPDATE prospects SET
      name=COALESCE(?, name), website=COALESCE(?, website),
      email=COALESCE(?, email), phone=COALESCE(?, phone),
      linkedin=COALESCE(?, linkedin), instagram=COALESCE(?, instagram),
      facebook=COALESCE(?, facebook), whatsapp=COALESCE(?, whatsapp),
      twitter=COALESCE(?, twitter), notes=COALESCE(?, notes),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    toDbVal(d.name), toDbVal(d.website), toDbVal(d.email), toDbVal(d.phone), toDbVal(d.linkedin), toDbVal(d.instagram),
    toDbVal(d.facebook), toDbVal(d.whatsapp), toDbVal(d.twitter), toDbVal(d.notes), req.params.id
  );
  contactSync.syncProspectToLinkedFinalProspects(Number(req.params.id));
  res.json(db.prepare("SELECT * FROM prospects WHERE id=?").get(req.params.id));
});

app.delete("/api/prospects/:id", (req, res) => {
  db.prepare("DELETE FROM prospects WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/campaign-domains/:id", (req, res) => {
  const row = db.prepare(`
    SELECT cd.*, c.name AS campaign_name
    FROM campaign_domains cd
    JOIN campaigns c ON c.id = cd.campaign_id
    WHERE cd.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const results = row.list_item_id
    ? db.prepare("SELECT * FROM processing_results WHERE list_item_id=?").all(row.list_item_id)
    : [];
  res.json({ ...row, row_data: tryParse(row.row_data, {}), processing_results: results });
});

// Build prospects from processing results
app.post("/api/campaign-domains/:id/prospects/from-results", (req, res) => {
  const cd = db.prepare("SELECT * FROM campaign_domains WHERE id=?").get(req.params.id);
  if (!cd || !cd.list_item_id) return res.status(400).json({ error: "No linked list item" });

  const mode = req.body?.mode === "overwrite" ? "overwrite" : "merge";
  const stats = syncProspectsForCampaignDomain(req.params.id, cd.list_item_id, mode);
  contactSync.reconcileFinalProspectsForListItem(cd.list_item_id);
  res.json({ ok: true, ...stats });
});

// ─── Outreach ───────────────────────────────────────────────

app.get("/api/prospects/:id/messages", (req, res) => {
  const rows = db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? ORDER BY slot").all(req.params.id);
  res.json(rows);
});

app.put("/api/prospects/:id/messages/:slot", (req, res) => {
  const { subject, body } = req.body;
  db.prepare(`
    INSERT INTO outreach_messages (prospect_id, slot, subject, body, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(prospect_id, slot) DO UPDATE SET
      subject=excluded.subject, body=excluded.body, updated_at=datetime('now')
  `).run(req.params.id, Number(req.params.slot), subject || "", body || "");
  res.json(db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? AND slot=?").get(req.params.id, req.params.slot));
});

app.post("/api/prospects/:id/messages/:slot/sent", (req, res) => {
  const { via } = req.body;
  db.prepare(`
    UPDATE outreach_messages SET status='sent', sent_at=datetime('now'), sent_via=?, updated_at=datetime('now')
    WHERE prospect_id=? AND slot=?
  `).run(via || "manual", req.params.id, Number(req.params.slot));
  res.json(db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? AND slot=?").get(req.params.id, Number(req.params.slot)));
});

app.post("/api/prospects/:id/messages/:slot/unsent", (req, res) => {
  db.prepare(`
    UPDATE outreach_messages SET status='draft', sent_at=NULL, sent_via=NULL, updated_at=datetime('now')
    WHERE prospect_id=? AND slot=?
  `).run(req.params.id, Number(req.params.slot));
  res.json(db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? AND slot=?").get(req.params.id, Number(req.params.slot)));
});

app.get("/api/prospects/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM prospects WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const messages = db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? ORDER BY slot").all(req.params.id);
  const campDomain = db.prepare(`
    SELECT cd.*, c.name AS campaign_name
    FROM campaign_domains cd
    JOIN campaigns c ON c.id = cd.campaign_id
    WHERE cd.id=?
  `).get(p.campaign_domain_id);
  const fp = db.prepare("SELECT id FROM final_prospects WHERE prospect_id=?").get(p.id);
  const finalProspectId = fp?.id || null;
  const messageTrackingSummary = finalProspectId
    ? messageTracking.getMessageTrackingSummary(finalProspectId)
    : null;
  res.json({
    ...p,
    messages,
    campaign_domain: campDomain,
    account_assignments: marketingAccounts.getAssignmentsForProspect(p.id),
    final_prospect_id: finalProspectId,
    message_tracking: messageTrackingSummary,
  });
});

app.get("*", (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexFile)) res.sendFile(indexFile);
  else res.status(404).send("index.html not found");
});

app.listen(PORT, HOST, () => {
  remoteDbSync.startWatcher();
  console.log(`Domain Sales app → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (remoteDbSync.isEnabled()) {
    const status = remoteDbSync.getStatus();
    const mode = status.mode === "api" ? "API push" : "SCP upload";
    console.log(`[remote-sync] Auto-push to VPS is ON (${mode})`);
  }
  if (syncApply.isReceiverEnabled()) {
    console.log("[sync-receiver] Accepting replication at POST /api/sync/apply");
  }
});
