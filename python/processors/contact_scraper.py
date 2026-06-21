"""Scrape contact info from prospect websites (home, contact, about, discovered pages)."""
import json
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from .chrome import get_driver, is_debug_running, launch_chrome, navigate, wait_for_debug_port

EMAIL_RE = re.compile(
    r"[a-zA-Z0-9][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}"
)
PHONE_RE = re.compile(
    r"(?<!\d)(?:\+\d{1,4}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?[\d\s().-]{5,22}\d(?!\d)"
)
PHONE_LABEL_RE = re.compile(
    r"^(phone|tel|telephone|mobile|call(?:\s+us)?|fax|whatsapp)\s*:?\s*$",
    re.I,
)
EMAIL_LABEL_RE = re.compile(r"^(e-?mail|mail)\s*:?\s*$", re.I)
WHATSAPP_NUM_RE = re.compile(r"(?:whatsapp|wa)[:\s]*\+?(\d{10,15})", re.I)

CONTACT_PATHS = [
    "",
    "/contact",
    "/contact-us",
    "/contactus",
    "/contacts",
    "/get-in-touch",
    "/about",
    "/about-us",
    "/aboutus",
    "/team",
    "/support",
    "/imprint",
    "/impressum",
    "/kontakt",
]

CONTACT_LINK_RE = re.compile(
    r"contact|about|team|support|reach|connect|imprint|impressum|kontakt|get-in-touch",
    re.I,
)

SOCIAL_HOSTS = {
    "linkedin": ("linkedin.com",),
    "instagram": ("instagram.com",),
    "facebook": ("facebook.com", "fb.com"),
    "twitter": ("twitter.com", "x.com"),
    "whatsapp": ("wa.me", "api.whatsapp.com", "chat.whatsapp.com"),
}

JUNK_EMAIL_FRAGMENTS = (
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
    "sentry", "wixpress", "example.com", "email.com", "domain.com",
    "yourname@", "name@example", "@2x.", "webpack", "bootstrap",
)

JUNK_EMAIL_DOMAINS = {
    "example.com", "email.com", "domain.com", "sentry.io", "wixpress.com",
    "schema.org", "googleapis.com", "cloudflare.com", "w3.org", "localhost",
    "png", "jpg", "jpeg", "gif", "svg", "webp",
}

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

CONTACT_KEYS = (
    "email", "phone", "phones_extra", "linkedin", "instagram", "facebook", "twitter", "whatsapp", "contact_form_url"
)

ENRICH_FIELDS = (
    "email", "phone", "linkedin", "instagram", "facebook", "twitter", "whatsapp", "contact_form_url"
)


def _progress(message: str, log_fn=None, **extra) -> None:
    payload = {"type": "progress", "message": message, **extra}
    print(json.dumps(payload), file=sys.stderr, flush=True)
    if log_fn:
        log_fn(message)


def _summary(contact: dict) -> str:
    parts = [k for k in ENRICH_FIELDS if contact.get(k)]
    if contact.get("phones_extra"):
        parts.append(f"+{len(contact['phones_extra'])} phone(s)")
    return ", ".join(parts) if parts else "none"


def _enriched_list(contact: dict) -> list[str]:
    found = [k for k in ENRICH_FIELDS if contact.get(k)]
    if contact.get("phones_extra"):
        found.append("phones_extra")
    return found


def _empty_contact():
    return {k: None for k in CONTACT_KEYS}


def _same_site(base: str, url: str) -> bool:
    try:
        b = urlparse(base)
        u = urlparse(url)
        if not u.netloc:
            return True
        return u.netloc.lower().lstrip("www.") == b.netloc.lower().lstrip("www.")
    except Exception:
        return False


def _normalize_url(base: str, href: str) -> str | None:
    if not href:
        return None
    href = href.strip()
    if href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None
    full = urljoin(base, href)
    if not _same_site(base, full):
        return None
    parsed = urlparse(full)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/") or full


def _is_valid_email(email: str) -> bool:
    email = email.lower().strip()
    if not email or len(email) > 120:
        return False
    if any(x in email for x in JUNK_EMAIL_FRAGMENTS):
        return False
    if "@" not in email:
        return False
    local, _, domain = email.partition("@")
    if not local or not domain or "." not in domain:
        return False
    if domain in JUNK_EMAIL_DOMAINS:
        return False
    if EMAIL_RE.fullmatch(email) is None:
        return False
    return True


def _pick_best_email(candidates: list[str]) -> str | None:
    scored = []
    for raw in candidates:
        email = raw.lower().strip().rstrip(".,;)")
        if not _is_valid_email(email):
            continue
        score = 0
        if any(x in email for x in ("info@", "contact@", "hello@", "sales@", "support@", "office@")):
            score += 3
        if email.count("@") == 1:
            score += 1
        scored.append((score, email))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], x[1]))
    return scored[0][1]


def _normalize_phone(raw: str) -> str | None:
    if not raw:
        return None
    cleaned = re.sub(r"[^\d+().\s-]", "", raw).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    digits = re.sub(r"\D", "", cleaned)
    # Allow 9-digit local numbers (e.g. Kenya 07xx) and up to 15 E.164
    if len(digits) < 9 or len(digits) > 15:
        return None
    if len(set(digits)) <= 2:
        return None
    return cleaned.strip()


def _is_phone_like(text: str) -> bool:
    if not text:
        return False
    t = text.strip()
    if len(t) < 8 or len(t) > 42:
        return False
    if "@" in t:
        return False
    digits = re.sub(r"\D", "", t)
    if len(digits) < 9 or len(digits) > 15:
        return False
    digit_ratio = len(digits) / max(len(t), 1)
    if digit_ratio < 0.45:
        return False
    return bool(re.search(r"\d{3}", t))


def _phone_candidates_from_text(text: str) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    if _is_phone_like(text):
        found.append(text.strip())
    for match in PHONE_RE.finditer(text):
        found.append(match.group(0).strip())
    return found


def _pick_best_phone(candidates: list[str]) -> tuple[str | None, list[str]]:
    scored: list[tuple[int, str]] = []
    seen_digits: set[str] = set()
    for raw in candidates:
        phone = _normalize_phone(raw)
        if not phone:
            continue
        digits = re.sub(r"\D", "", phone)
        if digits in seen_digits:
            continue
        seen_digits.add(digits)
        score = len(digits)
        if phone.startswith("+"):
            score += 4
        if any(ch in raw for ch in ("(", ")")):
            score += 1
        scored.append((score, phone))
    if not scored:
        return None, []
    scored.sort(key=lambda x: (-x[0], x[1]))
    primary = scored[0][1]
    extras = [p for _, p in scored[1:]]
    return primary, extras


def _phones_from_anchors(soup: BeautifulSoup) -> list[str]:
    phones: list[str] = []
    for a in soup.find_all("a"):
        href = (a.get("href") or "").strip()
        hl = href.lower()
        if hl.startswith("tel:"):
            phones.append(href[4:].split("?")[0])
        text = a.get_text(" ", strip=True)
        phones.extend(_phone_candidates_from_text(text))
    return phones


def _phones_from_labeled_lists(soup: BeautifulSoup) -> list[str]:
    phones: list[str] = []
    lis = soup.find_all("li")
    i = 0
    while i < len(lis):
        label = lis[i].get_text(" ", strip=True)
        if not PHONE_LABEL_RE.match(label):
            i += 1
            continue
        j = i + 1
        while j < len(lis):
            sibling_text = lis[j].get_text(" ", strip=True)
            if PHONE_LABEL_RE.match(sibling_text) or EMAIL_LABEL_RE.match(sibling_text):
                break
            for a in lis[j].find_all("a"):
                phones.extend(_phone_candidates_from_text(a.get_text(" ", strip=True)))
            phones.extend(_phone_candidates_from_text(sibling_text))
            j += 1
        i = j if j > i else i + 1
    return phones


def _phones_from_contact_sections(soup: BeautifulSoup) -> list[str]:
    phones: list[str] = []
    heading_re = re.compile(r"talk to us|contact us|get in touch|reach us|contact info", re.I)
    for heading in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "strong", "span"]):
        if not heading_re.search(heading.get_text(" ", strip=True)):
            continue
        parent = heading.find_parent(["div", "section", "footer", "aside"]) or heading.parent
        if not parent:
            continue
        phones.extend(_phones_from_anchors(parent))
        phones.extend(_phone_candidates_from_text(parent.get_text(" ", strip=True)))
    return phones


def _social_key(url: str) -> str | None:
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
    except Exception:
        return None
    for key, hosts in SOCIAL_HOSTS.items():
        if any(h in host for h in hosts):
            return key
    return None


def _clean_social_url(url: str) -> str:
    url = url.split("?")[0].split("#")[0].rstrip("/'\"")
    if _social_key(url) == "facebook":
        if any(x in url.lower() for x in ("/sharer", "/share.php", "/dialog/", "/plugins/")):
            return ""
    if _social_key(url) == "twitter" and "/intent" in url:
        return ""
    return url


def _facebook_from_meta(soup: BeautifulSoup) -> str | None:
    for tag in soup.find_all("meta", property=True, content=True):
        prop = (tag.get("property") or "").lower()
        if prop in ("og:url", "article:author") and "facebook.com" in (tag.get("content") or "").lower():
            cleaned = _clean_social_url(tag["content"])
            if cleaned:
                return cleaned
    return None


def _merge_contact(target: dict, found: dict) -> None:
    for key in CONTACT_KEYS:
        val = found.get(key)
        if not val:
            continue
        if key == "phones_extra":
            existing = target.get("phones_extra") or []
            if not isinstance(existing, list):
                existing = []
            merged = list(existing)
            for p in val if isinstance(val, list) else [val]:
                if p and p not in merged and p != target.get("phone"):
                    merged.append(p)
            if merged:
                target["phones_extra"] = merged
            continue
        if not target.get(key):
            target[key] = val


def _extract_json_ld(soup: BeautifulSoup) -> dict:
    out = _empty_contact()
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("@type") in ("Organization", "LocalBusiness", "Corporation", "Store"):
                if item.get("email") and _is_valid_email(str(item["email"])):
                    out["email"] = str(item["email"]).lower()
                if item.get("telephone"):
                    out["phone"] = _normalize_phone(str(item["telephone"]))
                same_as = item.get("sameAs") or []
                if isinstance(same_as, str):
                    same_as = [same_as]
                for link in same_as:
                    key = _social_key(str(link))
                    if key and not out.get(key):
                        cleaned = _clean_social_url(str(link))
                        if cleaned:
                            out[key] = cleaned
                for cp in item.get("contactPoint") or []:
                    if not isinstance(cp, dict):
                        continue
                    if cp.get("email") and not out["email"]:
                        em = str(cp["email"]).lower()
                        if _is_valid_email(em):
                            out["email"] = em
                    if cp.get("telephone") and not out["phone"]:
                        out["phone"] = _normalize_phone(str(cp["telephone"]))
    return out


def _extract_from_soup(soup: BeautifulSoup, page_url: str) -> dict:
    out = _empty_contact()
    emails: list[str] = []
    phones: list[str] = []

    phones.extend(_phones_from_anchors(soup))
    phones.extend(_phones_from_labeled_lists(soup))
    phones.extend(_phones_from_contact_sections(soup))

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        hl = href.lower()
        if hl.startswith("mailto:"):
            emails.append(href[7:].split("?")[0])
        elif not hl.startswith("tel:"):
            key = _social_key(href)
            if key:
                cleaned = _clean_social_url(href)
                if cleaned and not out.get(key):
                    out[key] = cleaned

    text = soup.get_text(" ", strip=True)
    emails.extend(EMAIL_RE.findall(text))
    phones.extend(_phone_candidates_from_text(text))

    wa_match = WHATSAPP_NUM_RE.search(text)
    if wa_match and not out["whatsapp"]:
        out["whatsapp"] = f"https://wa.me/{wa_match.group(1)}"

    for tag in soup.find_all(["meta", "link"]):
        content = tag.get("content") or tag.get("href") or ""
        if "@" in content:
            emails.extend(EMAIL_RE.findall(content))
        phones.extend(_phone_candidates_from_text(content))
        key = _social_key(content)
        if key and not out.get(key):
            cleaned = _clean_social_url(content)
            if cleaned:
                out[key] = cleaned

    out["email"] = _pick_best_email(emails)
    primary, extras = _pick_best_phone(phones)
    out["phone"] = primary
    out["phones_extra"] = extras
    if primary:
        out["whatsapp"] = primary
    elif out.get("whatsapp") and not out.get("phone"):
        wa = str(out["whatsapp"])
        wa_match = re.search(r"wa\.me/(\d+)", wa)
        if wa_match:
            out["phone"] = wa_match.group(1)
        else:
            digits = re.sub(r"\D", "", wa)
            if digits:
                out["phone"] = digits

    if not out.get("facebook"):
        fb = _facebook_from_meta(soup)
        if fb:
            out["facebook"] = fb

    _merge_contact(out, _extract_json_ld(soup))

    if soup.find("form"):
        has_contact_inputs = bool(
            soup.find("input", type="email")
            or soup.find("textarea")
            or soup.find("input", attrs={"name": re.compile(r"email|message|contact", re.I)})
        )
        if has_contact_inputs and not out["contact_form_url"]:
            out["contact_form_url"] = page_url

    return out


def _discover_urls(soup: BeautifulSoup, base_url: str, limit: int = 10) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True)
        if not CONTACT_LINK_RE.search(href) and not CONTACT_LINK_RE.search(text):
            continue
        full = _normalize_url(base_url, href)
        if not full or full in seen:
            continue
        seen.add(full)
        found.append(full)
        if len(found) >= limit:
            break
    return found


def _fetch_html(url: str, session: requests.Session) -> str | None:
    try:
        r = session.get(url, timeout=14, allow_redirects=True)
        if r.status_code >= 400:
            return None
        ctype = (r.headers.get("content-type") or "").lower()
        if "text/html" not in ctype and "application/xhtml" not in ctype:
            return None
        return r.text
    except Exception:
        return None


def _scrape_html(html: str, page_url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    return _extract_from_soup(soup, page_url)


def _collect_page_urls(base_url: str, home_html: str | None) -> list[str]:
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    urls: list[str] = []
    seen: set[str] = set()

    def add(u: str | None) -> None:
        if not u:
            return
        key = u.rstrip("/")
        if key not in seen:
            seen.add(key)
            urls.append(key)

    add(origin)
    for path in CONTACT_PATHS:
        if path:
            add(origin + path)

    if home_html:
        soup = BeautifulSoup(home_html, "html.parser")
        for u in _discover_urls(soup, base_url):
            add(u)

    return urls[:14]


def _scrape_with_requests(base_url: str, log=None) -> dict:
    merged = _empty_contact()
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})

    _progress(f"HTTP: fetching homepage {base_url}", log, phase="http")
    home_html = _fetch_html(base_url, session)
    if home_html:
        found = _scrape_html(home_html, base_url)
        _merge_contact(merged, found)
        _progress(f"HTTP homepage parsed — {_summary(found)} (total: {_summary(merged)})", log, phase="http")

    page_urls = _collect_page_urls(base_url, home_html)
    for page_url in page_urls:
        if page_url.rstrip("/") == base_url.rstrip("/"):
            continue
        _progress(f"HTTP: fetching {page_url}", log, phase="http")
        html = _fetch_html(page_url, session)
        if not html:
            _progress(f"HTTP: skipped {page_url} (no HTML)", log, phase="http")
            continue
        found = _scrape_html(html, page_url)
        _merge_contact(merged, found)
        _progress(f"HTTP parsed — {_summary(found)} (total: {_summary(merged)})", log, phase="http")
        if all(merged.get(k) for k in ("email", "phone", "facebook", "linkedin")):
            _progress("HTTP: core contact fields found, stopping early", log, phase="http")
            break

    return merged


def _scrape_with_selenium(urls: list[str], log=None, visible: bool = True) -> dict:
    merged = _empty_contact()
    if visible:
        _progress("Chrome: ensuring visible browser is running (watch the Chrome window)", log, phase="selenium")
        if not is_debug_running():
            launch_chrome()
            wait_for_debug_port(25)
    try:
        driver = get_driver()
    except Exception as exc:
        _progress(f"Chrome: could not attach Selenium — {exc}", log, phase="selenium")
        return merged

    limit = min(len(urls), 8)
    for i, page_url in enumerate(urls[:limit], 1):
        _progress(f"Chrome [{i}/{limit}]: navigating to {page_url}", log, phase="selenium", url=page_url)
        try:
            navigate(driver, page_url)
            time.sleep(2.5)
            found = _scrape_html(driver.page_source, page_url)
            _merge_contact(merged, found)
            _progress(
                f"Chrome [{i}/{limit}]: {_summary(found)} (total: {_summary(merged)})",
                log,
                phase="selenium",
            )
        except Exception as exc:
            _progress(f"Chrome [{i}/{limit}]: error — {exc}", log, phase="selenium")
    return merged


def _needs_selenium(contact: dict) -> bool:
    if contact.get("email") and not contact.get("phone"):
        return True
    if not contact.get("facebook"):
        return True
    core = sum(1 for k in ("email", "phone", "linkedin", "instagram", "facebook", "whatsapp") if contact.get(k))
    return core < 3


def run(payload: dict) -> dict:
    url = payload.get("url", "").strip()
    if not url:
        return {"ok": False, "error": "url required"}
    if not url.startswith("http"):
        url = "https://" + url
    base = url.rstrip("/")
    visible = payload.get("visible", True)
    log_lines: list[str] = []

    def log_fn(msg: str) -> None:
        log_lines.append(msg)

    _progress(f"Contact scrape started for {base}", log_fn, phase="init")

    merged = _scrape_with_requests(base, log_fn)

    if _needs_selenium(merged):
        page_urls = _collect_page_urls(base, None)
        if base not in page_urls:
            page_urls.insert(0, base)
        _progress(
            f"Switching to visible Chrome — missing fields: "
            f"{', '.join(k for k in ENRICH_FIELDS if not merged.get(k)) or 'none'}",
            log_fn,
            phase="selenium",
        )
        selenium_data = _scrape_with_selenium(page_urls, log_fn, visible=visible)
        _merge_contact(merged, selenium_data)
    else:
        _progress("HTTP scrape sufficient — skipping Chrome", log_fn, phase="done")

    pages_checked = len(_collect_page_urls(base, None))
    enriched = _enriched_list(merged)
    found_count = len(enriched)

    _progress(f"Scrape complete — {found_count} field(s): {', '.join(enriched) or 'none'}", log_fn, phase="done")

    return {
        "ok": True,
        "contact": merged,
        "url": base,
        "pages_checked": pages_checked,
        "fields_found": found_count,
        "enriched": enriched,
        "log": log_lines,
    }
