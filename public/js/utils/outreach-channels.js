const CHANNEL_ORDER = ["gmail", "whatsapp", "linkedin", "instagram", "facebook"];

export function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMobile = isAndroid || isIOS;
  return { isAndroid, isIOS, isMobile };
}

function enc(value) {
  return encodeURIComponent(value || "");
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

export function extractWhatsAppPhone(value) {
  if (!value) return "";
  if (value.includes("wa.me/")) {
    const m = value.match(/wa\.me\/(\d+)/);
    if (m) return m[1];
  }
  return digitsOnly(value);
}

export function normalizeLinkedInUrl(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const slug = trimmed.replace(/^@/, "").replace(/^linkedin\.com\/in\//i, "").replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug}`;
}

export function extractLinkedInSlug(value) {
  const url = normalizeLinkedInUrl(value);
  if (!url) return "";
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : "";
}

export function normalizeInstagramUrl(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "") + "/";
  const handle = trimmed.replace(/^@/, "").replace(/^instagram\.com\//i, "").replace(/\/$/, "");
  return `https://www.instagram.com/${handle}/`;
}

export function extractInstagramHandle(value) {
  const url = normalizeInstagramUrl(value);
  if (!url) return "";
  const m = url.match(/instagram\.com\/([^/?#]+)/i);
  return m ? m[1] : "";
}

export function normalizeFacebookUrl(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const slug = trimmed.replace(/^@/, "").replace(/^facebook\.com\//i, "").replace(/\/$/, "");
  return `https://www.facebook.com/${slug}`;
}

export function extractFacebookSlug(value) {
  const url = normalizeFacebookUrl(value);
  if (!url) return "";
  const m = url.match(/facebook\.com\/([^/?#]+)/i);
  return m ? m[1] : "";
}

export function buildGmailUrl({ senderEmail, to, subject, body }, platform = detectPlatform()) {
  if (platform.isAndroid) {
    const fallback = `https://mail.google.com/mail/?authuser=${encodeURIComponent(senderEmail || "")}&view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(subject || "")}&body=${encodeURIComponent(body || "")}`;
    return `intent://send?to=${enc(to)}&subject=${enc(subject)}&body=${enc(body)}#Intent;scheme=mailto;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  }
  if (platform.isIOS) {
    return `googlegmail://co?to=${enc(to)}&subject=${enc(subject)}&body=${enc(body)}`;
  }
  return `https://mail.google.com/mail/?authuser=${enc(senderEmail)}&view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;
}

export function buildWhatsAppUrl({ prospectWhatsApp, body }, platform = detectPlatform()) {
  const phone = extractWhatsAppPhone(prospectWhatsApp);
  const text = enc(body);
  if (!phone) return `https://wa.me/?text=${text}`;

  if (platform.isAndroid) {
    const fallback = `https://wa.me/${phone}?text=${text}`;
    return `intent://send?phone=${phone}&text=${text}#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  }
  if (platform.isIOS) {
    return `whatsapp://send?phone=${phone}&text=${text}`;
  }
  return `https://web.whatsapp.com/send?phone=${phone}&text=${text}`;
}

export function buildLinkedInUrl({ prospectLinkedIn }, platform = detectPlatform()) {
  const webUrl = normalizeLinkedInUrl(prospectLinkedIn);
  if (!webUrl) return null;
  const slug = extractLinkedInSlug(prospectLinkedIn);
  if (platform.isMobile && slug) {
    return `linkedin://in/${slug}`;
  }
  return webUrl;
}

export function buildInstagramUrl({ prospectInstagram }, platform = detectPlatform()) {
  const webUrl = normalizeInstagramUrl(prospectInstagram);
  if (!webUrl) return null;
  const handle = extractInstagramHandle(prospectInstagram);
  if (platform.isMobile && handle) {
    return `instagram://user?username=${enc(handle)}`;
  }
  return webUrl;
}

export function buildFacebookUrl({ prospectFacebook }, platform = detectPlatform()) {
  const webUrl = normalizeFacebookUrl(prospectFacebook);
  if (!webUrl) return null;
  const slug = extractFacebookSlug(prospectFacebook);
  if (platform.isMobile && slug) {
    return `fb://profile/${slug}`;
  }
  return webUrl;
}

export function openOutreachUrl(url, platform = detectPlatform()) {
  if (!url) return;
  if (platform.isAndroid && url.startsWith("intent://")) {
    window.location.href = url;
    return;
  }
  if ((platform.isIOS || platform.isMobile) && /^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("http")) {
    window.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ url: string|null, needsClipboard: boolean, hint: string }}
 */
export function resolveProspectWhatsApp(prospect) {
  return (prospect?.phone || prospect?.whatsapp || "").trim();
}

export function buildChannelLaunch(channel, { prospect, senderIdentifier, subject, body }, platform = detectPlatform()) {
  const sender = senderIdentifier || "";

  switch (channel) {
    case "gmail": {
      if (!prospect.email) {
        return { url: null, needsClipboard: false, hint: "Prospect has no email address." };
      }
      return {
        url: buildGmailUrl({
          senderEmail: sender,
          to: prospect.email,
          subject,
          body,
        }, platform),
        needsClipboard: false,
        hint: `Compose in Gmail as ${sender}`,
      };
    }
    case "whatsapp": {
      const number = resolveProspectWhatsApp(prospect);
      if (!number) {
        return { url: null, needsClipboard: false, hint: "Prospect has no phone / WhatsApp number." };
      }
      return {
        url: buildWhatsAppUrl({ prospectWhatsApp: number, body }, platform),
        needsClipboard: false,
        hint: `Send from WhatsApp account: ${sender}`,
      };
    }
    case "linkedin": {
      if (!prospect.linkedin) {
        return { url: null, needsClipboard: false, hint: "Prospect has no LinkedIn profile." };
      }
      return {
        url: buildLinkedInUrl({ prospectLinkedIn: prospect.linkedin }, platform),
        needsClipboard: true,
        hint: `Open LinkedIn profile — send from account: ${sender}`,
      };
    }
    case "instagram": {
      if (!prospect.instagram) {
        return { url: null, needsClipboard: false, hint: "Prospect has no Instagram profile." };
      }
      return {
        url: buildInstagramUrl({ prospectInstagram: prospect.instagram }, platform),
        needsClipboard: true,
        hint: `Open Instagram profile — send from account: ${sender}`,
      };
    }
    case "facebook": {
      if (!prospect.facebook) {
        return { url: null, needsClipboard: false, hint: "Prospect has no Facebook profile." };
      }
      const slug = extractFacebookSlug(prospect.facebook);
      const messengerUrl = slug && platform.isMobile
        ? `fb-messenger://user-thread/${slug}`
        : slug
          ? `https://m.me/${slug}`
          : buildFacebookUrl({ prospectFacebook: prospect.facebook }, platform);
      return {
        url: messengerUrl || buildFacebookUrl({ prospectFacebook: prospect.facebook }, platform),
        needsClipboard: true,
        hint: `Open Facebook / Messenger — send from account: ${sender}`,
      };
    }
    default:
      return { url: null, needsClipboard: false, hint: "Unknown channel." };
  }
}

export { CHANNEL_ORDER };
