function trimOrNull(value) {
  const v = typeof value === "string" ? value.trim() : value;
  return v || null;
}

function normalizePhoneDigits(value) {
  const raw = trimOrNull(value);
  if (!raw) return null;
  if (/wa\.me\//i.test(raw)) {
    const m = raw.match(/wa\.me\/(\d+)/i);
    if (m) return m[1];
  }
  const digits = raw.replace(/\D/g, "");
  return digits || null;
}

/**
 * Phone and WhatsApp are the same contact for prospects.
 * Prefer phone as source of truth; mirror to whatsapp.
 */
function bindPhoneWhatsApp(fields = {}) {
  const out = { ...fields };
  const phone = trimOrNull(out.phone);
  const whatsapp = trimOrNull(out.whatsapp);

  if (phone) {
    out.phone = phone;
    out.whatsapp = phone;
  } else if (whatsapp) {
    out.phone = whatsapp;
    out.whatsapp = whatsapp;
  }

  return out;
}

function resolveWhatsApp(contact) {
  return trimOrNull(contact?.phone) || trimOrNull(contact?.whatsapp) || "";
}

function migratePhoneWhatsAppBinding(db) {
  for (const table of ["prospects", "final_prospects"]) {
    db.prepare(`
      UPDATE ${table}
      SET whatsapp=phone, updated_at=datetime('now')
      WHERE phone IS NOT NULL AND TRIM(phone) != ''
        AND (whatsapp IS NULL OR TRIM(whatsapp) = '' OR whatsapp != phone)
    `).run();

    db.prepare(`
      UPDATE ${table}
      SET phone=whatsapp, updated_at=datetime('now')
      WHERE whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
        AND (phone IS NULL OR TRIM(phone) = '')
    `).run();
  }
}

module.exports = {
  bindPhoneWhatsApp,
  resolveWhatsApp,
  normalizePhoneDigits,
  migratePhoneWhatsAppBinding,
};
