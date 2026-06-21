const { db, today } = require("../db");

const SLOT_LABELS = ["Initial", "Follow-up 1", "Follow-up 2", "Follow-up 3", "Follow-up 4"];
const MESSAGE_SLOTS = [0, 1, 2, 3, 4];

function getDefaultFollowUpInterval() {
  const row = db.prepare("SELECT value FROM marketing_settings WHERE key='follow_up_interval_days'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function setDefaultFollowUpInterval(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: "follow_up_interval_days must be a positive number" };
  }
  db.prepare(`
    INSERT INTO marketing_settings (key, value) VALUES ('follow_up_interval_days', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(n));
  return { ok: true, followUpIntervalDays: n };
}

function isValidDateStr(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function computeScheduledDate(startDate, slot, intervalDays) {
  return addDays(startDate, slot * intervalDays);
}

function deriveMessageStatus(message, scheduledDate) {
  if (message?.status === "sent") return "sent";
  if (!scheduledDate) return "draft";
  const now = today();
  if (scheduledDate < now) return "overdue";
  if (scheduledDate === now) return "due";
  return "scheduled";
}

function defaultStartDateForFinalProspect(finalProspectId) {
  const row = db.prepare(`
    SELECT fp.prospect_id, fpa.assigned_at, fp.created_at
    FROM final_prospects fp
    LEFT JOIN final_prospect_account_assignments fpa ON fpa.final_prospect_id = fp.id
    WHERE fp.id=?
  `).get(finalProspectId);
  const raw = row?.assigned_at || row?.created_at;
  if (raw) return raw.slice(0, 10);
  return today();
}

function syncTrackingProspectId(finalProspectId, prospectId) {
  db.prepare(`
    UPDATE prospect_message_tracking
    SET prospect_id=?, updated_at=datetime('now')
    WHERE final_prospect_id=?
  `).run(prospectId, finalProspectId);
}

function getOrCreateTracking(finalProspectId) {
  let row = db.prepare("SELECT * FROM prospect_message_tracking WHERE final_prospect_id=?").get(finalProspectId);
  if (row) return row;

  const fp = db.prepare("SELECT prospect_id FROM final_prospects WHERE id=?").get(finalProspectId);
  const startDate = defaultStartDateForFinalProspect(finalProspectId);
  const interval = getDefaultFollowUpInterval();

  db.prepare(`
    INSERT INTO prospect_message_tracking (final_prospect_id, prospect_id, start_date, follow_up_interval_days)
    VALUES (?, ?, ?, ?)
  `).run(finalProspectId, fp?.prospect_id || null, startDate, interval);

  return db.prepare("SELECT * FROM prospect_message_tracking WHERE final_prospect_id=?").get(finalProspectId);
}

function getMessagesForProspect(prospectId) {
  if (!prospectId) return [];
  return db.prepare("SELECT * FROM outreach_messages WHERE prospect_id=? ORDER BY slot").all(prospectId);
}

function buildTrackingSummary(tracking) {
  const messages = getMessagesForProspect(tracking.prospect_id);
  const slots = MESSAGE_SLOTS.map((slot) => {
    const msg = messages.find((m) => m.slot === slot);
    const scheduledDate = computeScheduledDate(
      tracking.start_date,
      slot,
      tracking.follow_up_interval_days,
    );
    return {
      slot,
      label: SLOT_LABELS[slot],
      status: deriveMessageStatus(msg, scheduledDate),
      scheduled_date: scheduledDate,
      sent_at: msg?.sent_at || null,
      sent_via: msg?.sent_via || null,
    };
  });

  return {
    final_prospect_id: tracking.final_prospect_id,
    prospect_id: tracking.prospect_id,
    start_date: tracking.start_date,
    follow_up_interval_days: tracking.follow_up_interval_days,
    updated_at: tracking.updated_at,
    messages: slots,
  };
}

function getMessageTrackingSummary(finalProspectId) {
  const tracking = getOrCreateTracking(finalProspectId);
  return buildTrackingSummary(tracking);
}

function updateTracking(finalProspectId, data) {
  getOrCreateTracking(finalProspectId);

  if (data.startDate !== undefined && !isValidDateStr(data.startDate)) {
    return { ok: false, error: "startDate must be YYYY-MM-DD" };
  }

  if (data.followUpIntervalDays !== undefined) {
    const n = parseInt(data.followUpIntervalDays, 10);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: "followUpIntervalDays must be a positive number" };
    }
  }

  db.prepare(`
    UPDATE prospect_message_tracking SET
      start_date=COALESCE(?, start_date),
      follow_up_interval_days=COALESCE(?, follow_up_interval_days),
      updated_at=datetime('now')
    WHERE final_prospect_id=?
  `).run(
    data.startDate ?? null,
    data.followUpIntervalDays !== undefined ? parseInt(data.followUpIntervalDays, 10) : null,
    finalProspectId,
  );

  return { ok: true, tracking: getMessageTrackingSummary(finalProspectId) };
}

function resetStartDate(finalProspectId, startDate) {
  if (!isValidDateStr(startDate)) {
    return { ok: false, error: "startDate must be YYYY-MM-DD" };
  }
  return updateTracking(finalProspectId, { startDate });
}

function resetMessageStatus(finalProspectId) {
  const tracking = getOrCreateTracking(finalProspectId);
  if (tracking.prospect_id) {
    db.prepare(`
      UPDATE outreach_messages
      SET status='draft', sent_at=NULL, sent_via=NULL, updated_at=datetime('now')
      WHERE prospect_id=?
    `).run(tracking.prospect_id);
  }
  return { ok: true, tracking: getMessageTrackingSummary(finalProspectId) };
}

function enrichProspectsWithTracking(prospects) {
  return prospects.map((p) => ({
    ...p,
    message_tracking: getMessageTrackingSummary(p.final_prospect_id),
  }));
}

module.exports = {
  SLOT_LABELS,
  MESSAGE_SLOTS,
  getDefaultFollowUpInterval,
  setDefaultFollowUpInterval,
  getMessageTrackingSummary,
  updateTracking,
  resetStartDate,
  resetMessageStatus,
  syncTrackingProspectId,
  enrichProspectsWithTracking,
  getOrCreateTracking,
};
