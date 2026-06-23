const CHANNEL_ORDER = ["gmail", "whatsapp", "linkedin", "instagram", "facebook"];

const ANDROID_PACKAGES = {
  gmail: "com.google.android.gm",
  whatsapp: "com.whatsapp",
  linkedin: "com.linkedin.android",
  instagram: "com.instagram.android",
  messenger: "com.facebook.orca",
};

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

function buildAndroidIntent(path, packageName, fallbackUrl, scheme = "https") {
  const intentPath = String(path).replace(/^https?:\/\//i, "");
  return `intent://${intentPath}#Intent;scheme=${scheme};package=${packageName};S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
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

export function buildGmailUrls({ senderEmail, to, subject, body }, platform = detectPlatform()) {
  const webUrl = `https://mail.google.com/mail/?authuser=${enc(senderEmail)}&view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;

  if (platform.isAndroid) {
    const appUrl = buildAndroidIntent(
      `send?to=${enc(to)}&subject=${enc(subject)}&body=${enc(body)}`,
      ANDROID_PACKAGES.gmail,
      webUrl,
      "mailto",
    );
    return { appUrl, webUrl };
  }

  if (platform.isIOS) {
    const appUrl = `googlegmail:///co?to=${enc(to)}&subject=${enc(subject)}&body=${enc(body)}`;
    return { appUrl, webUrl };
  }

  return { appUrl: null, webUrl };
}

export function buildWhatsAppUrls({ prospectWhatsApp, body }, platform = detectPlatform()) {
  const phone = extractWhatsAppPhone(prospectWhatsApp);
  const text = enc(body);
  const webUrl = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;

  if (platform.isAndroid) {
    const path = phone ? `send?phone=${phone}&text=${text}` : `send?text=${text}`;
    const appUrl = buildAndroidIntent(path, ANDROID_PACKAGES.whatsapp, webUrl, "whatsapp");
    return { appUrl, webUrl };
  }

  if (platform.isIOS) {
    const appUrl = phone
      ? `whatsapp://send?phone=${phone}&text=${text}`
      : `whatsapp://send?text=${text}`;
    return { appUrl, webUrl };
  }

  return {
    appUrl: null,
    webUrl: phone ? `https://web.whatsapp.com/send?phone=${phone}&text=${text}` : webUrl,
  };
}

export function buildLinkedInUrls({ prospectLinkedIn }, platform = detectPlatform()) {
  const webUrl = normalizeLinkedInUrl(prospectLinkedIn);
  if (!webUrl) return { appUrl: null, webUrl: null };
  const slug = extractLinkedInSlug(prospectLinkedIn);
  if (!slug) return { appUrl: null, webUrl };

  if (platform.isAndroid) {
    const appUrl = buildAndroidIntent(
      `www.linkedin.com/in/${slug}`,
      ANDROID_PACKAGES.linkedin,
      webUrl,
    );
    return { appUrl, webUrl };
  }

  if (platform.isIOS) {
    return { appUrl: `linkedin://in/${slug}`, webUrl };
  }

  return { appUrl: null, webUrl };
}

export function buildInstagramUrls({ prospectInstagram }, platform = detectPlatform()) {
  const webUrl = normalizeInstagramUrl(prospectInstagram);
  if (!webUrl) return { appUrl: null, webUrl: null };
  const handle = extractInstagramHandle(prospectInstagram);
  if (!handle) return { appUrl: null, webUrl };

  if (platform.isAndroid) {
    const appUrl = buildAndroidIntent(
      `instagram.com/_u/${handle}`,
      ANDROID_PACKAGES.instagram,
      webUrl,
    );
    return { appUrl, webUrl };
  }

  if (platform.isIOS) {
    return { appUrl: `instagram://user?username=${enc(handle)}`, webUrl };
  }

  return { appUrl: null, webUrl };
}

export function buildFacebookMessengerUrls({ prospectFacebook }, platform = detectPlatform()) {
  const webProfile = normalizeFacebookUrl(prospectFacebook);
  if (!webProfile) return { appUrl: null, webUrl: null };
  const slug = extractFacebookSlug(prospectFacebook);
  const messengerWeb = slug ? `https://m.me/${slug}` : webProfile;

  if (platform.isAndroid && slug) {
    const appUrl = buildAndroidIntent(
      `m.me/${slug}`,
      ANDROID_PACKAGES.messenger,
      messengerWeb,
    );
    return { appUrl, webUrl: messengerWeb };
  }

  if (platform.isIOS && slug) {
    // m.me is a universal link — opens Messenger when installed, Safari otherwise
    return { appUrl: messengerWeb, webUrl: webProfile };
  }

  return { appUrl: null, webUrl: messengerWeb };
}

function openWithAppFallback(appUrl, webUrl) {
  const fallback = webUrl || appUrl;
  const timer = setTimeout(() => {
    window.location.assign(fallback);
  }, 2000);

  const cancel = () => clearTimeout(timer);
  window.addEventListener("pagehide", cancel, { once: true });
  window.addEventListener("blur", cancel, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel();
  }, { once: true });

  window.location.href = appUrl;
}

/**
 * Open outreach link — native app on mobile when possible, browser fallback otherwise.
 * @param {string|null} appUrl - Deep link or Android intent
 * @param {string|null} webUrl - HTTPS fallback (profile page, web compose, etc.)
 */
export function openOutreachUrl(appUrl, webUrl, platform = detectPlatform()) {
  const web = webUrl || appUrl;
  if (!web && !appUrl) return;

  if (!platform.isMobile) {
    window.open(web, "_blank", "noopener,noreferrer");
    return;
  }

  if (platform.isAndroid && appUrl?.startsWith("intent://")) {
    window.location.href = appUrl;
    return;
  }

  const isCustomScheme = appUrl && /^[a-z][a-z0-9+.-]*:/i.test(appUrl) && !appUrl.startsWith("http");
  if (isCustomScheme) {
    openWithAppFallback(appUrl, web);
    return;
  }

  // Universal links (e.g. m.me on iOS) or mobile web URLs
  window.location.href = appUrl || web;
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

export function resolveProspectWhatsApp(prospect) {
  return (prospect?.phone || prospect?.whatsapp || "").trim();
}

/**
 * @returns {{ appUrl: string|null, webUrl: string|null, needsClipboard: boolean, hint: string }}
 */
export function buildChannelLaunch(channel, { prospect, senderIdentifier, subject, body }, platform = detectPlatform()) {
  const sender = senderIdentifier || "";

  switch (channel) {
    case "gmail": {
      if (!prospect.email) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no email address." };
      }
      const urls = buildGmailUrls({
        senderEmail: sender,
        to: prospect.email,
        subject,
        body,
      }, platform);
      return {
        ...urls,
        needsClipboard: false,
        hint: `Compose in Gmail as ${sender}`,
      };
    }
    case "whatsapp": {
      const number = resolveProspectWhatsApp(prospect);
      if (!number) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no phone / WhatsApp number." };
      }
      const urls = buildWhatsAppUrls({ prospectWhatsApp: number, body }, platform);
      return {
        ...urls,
        needsClipboard: false,
        hint: `Send from WhatsApp account: ${sender}`,
      };
    }
    case "linkedin": {
      if (!prospect.linkedin) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no LinkedIn profile." };
      }
      const urls = buildLinkedInUrls({ prospectLinkedIn: prospect.linkedin }, platform);
      if (!urls.webUrl) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no LinkedIn profile." };
      }
      return {
        ...urls,
        needsClipboard: true,
        hint: `Open LinkedIn profile — send from account: ${sender}`,
      };
    }
    case "instagram": {
      if (!prospect.instagram) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no Instagram profile." };
      }
      const urls = buildInstagramUrls({ prospectInstagram: prospect.instagram }, platform);
      if (!urls.webUrl) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no Instagram profile." };
      }
      return {
        ...urls,
        needsClipboard: true,
        hint: `Open Instagram profile — send from account: ${sender}`,
      };
    }
    case "facebook": {
      if (!prospect.facebook) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no Facebook profile." };
      }
      const urls = buildFacebookMessengerUrls({ prospectFacebook: prospect.facebook }, platform);
      if (!urls.webUrl) {
        return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Prospect has no Facebook profile." };
      }
      return {
        ...urls,
        needsClipboard: true,
        hint: `Open Messenger — send from account: ${sender}`,
      };
    }
    default:
      return { appUrl: null, webUrl: null, needsClipboard: false, hint: "Unknown channel." };
  }
}

// Legacy single-url exports for any external callers
export function buildGmailUrl(params, platform) {
  const { webUrl } = buildGmailUrls(params, platform);
  return webUrl;
}

export function buildWhatsAppUrl(params, platform) {
  const { webUrl } = buildWhatsAppUrls(params, platform);
  return webUrl;
}

export function buildLinkedInUrl(params, platform) {
  const { appUrl, webUrl } = buildLinkedInUrls(params, platform);
  return appUrl || webUrl;
}

export function buildInstagramUrl(params, platform) {
  const { appUrl, webUrl } = buildInstagramUrls(params, platform);
  return appUrl || webUrl;
}

export function buildFacebookUrl(params, platform) {
  const { webUrl } = buildFacebookMessengerUrls(params, platform);
  return webUrl;
}

export { CHANNEL_ORDER };
