"""Apify proxy fallback for Google SERP when Selenium hits CAPTCHA."""
import os
import re
from urllib.parse import quote_plus, urlparse

import requests
from bs4 import BeautifulSoup


APIFY_PROXY_PASSWORD = os.environ.get("APIFY_PROXY_PASSWORD", "").strip()
APIFY_PROXY_HOST = os.environ.get("APIFY_PROXY_HOST", "proxy.apify.com").strip()
APIFY_PROXY_PORT = int(os.environ.get("APIFY_PROXY_PORT", "8000"))
APIFY_PROXY_USERNAME = os.environ.get("APIFY_PROXY_USERNAME", "groups-GOOGLE_SERP").strip()
APIFY_TIMEOUT_SEC = int(os.environ.get("APIFY_TIMEOUT_SEC", "60"))

GOOGLE_CAPTCHA_RE = re.compile(
    r"unusual traffic|automated queries|captcha|i'm not a robot|"
    r"verify you.{0,20}re not a robot|recaptcha|before you continue|"
    r"our systems have detected",
    re.I,
)

APIFY_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    )
}


def _extract_domain(url: str) -> str:
    try:
        host = (urlparse(url).netloc or "").lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def _proxy_url() -> str:
    return (
        f"http://{APIFY_PROXY_USERNAME}:{APIFY_PROXY_PASSWORD}"
        f"@{APIFY_PROXY_HOST}:{APIFY_PROXY_PORT}"
    )


def _proxies() -> dict:
    proxy = _proxy_url()
    return {"http": proxy, "https": proxy}


def _parse_google_html(html: str) -> list[dict]:
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    body_text = soup.get_text(" ", strip=True)
    if GOOGLE_CAPTCHA_RE.search(body_text):
        raise RuntimeError("Apify proxy returned CAPTCHA/block page")

    out = []
    seen = set()
    for block in soup.select("#search div.g, #rso div.g, .MjjYud"):
        link = block.select_one("a[href]")
        if not link:
            continue
        href = (link.get("href") or "").strip()
        if not href.startswith("http"):
            continue
        domain = _extract_domain(href)
        if not domain:
            continue
        title_el = block.select_one("h3")
        title = title_el.get_text(" ", strip=True) if title_el else ""
        snippet_el = block.select_one(".VwiC3b, .IsZvec, .yXK7lf, div[data-sncf]")
        snippet = snippet_el.get_text(" ", strip=True) if snippet_el else ""

        key = (domain, href)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "domain": domain,
            "title": title,
            "snippet": snippet,
            "url": href,
        })
    return out


def search_google_via_apify(query: str, max_pages: int = 3) -> dict:
    if not APIFY_PROXY_PASSWORD:
        return {"ok": False, "error": "APIFY_PROXY_PASSWORD is not set"}
    if not query:
        return {"ok": False, "error": "query is required"}

    all_results = []
    seen = set()
    pages = max(1, int(max_pages or 1))

    try:
        for page in range(pages):
            start = page * 10
            url = f"https://www.google.com/search?q={quote_plus(query)}&hl=en&gl=us&lr=lang_en&num=10"
            if start:
                url += f"&start={start}"

            resp = requests.get(
                url,
                headers=APIFY_HEADERS,
                proxies=_proxies(),
                timeout=APIFY_TIMEOUT_SEC,
                allow_redirects=True,
                verify=False,
            )
            if resp.status_code >= 400:
                return {
                    "ok": False,
                    "error": f"Apify proxy HTTP {resp.status_code}: {resp.text[:250]}",
                }

            page_results = _parse_google_html(resp.text)
            for r in page_results:
                key = (r.get("domain"), r.get("url"))
                if key in seen:
                    continue
                seen.add(key)
                all_results.append(r)

            if not page_results:
                break

        return {
            "ok": True,
            "results": all_results,
            "raw_count": len(all_results),
            "source": "apify_proxy",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
