"""Shared Google SERP result parsing."""
import time
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from urllib.parse import urlparse, parse_qs, unquote
from .domain_utils import extract_domain_from_url


def wait_for_serp(driver, timeout: float = 15) -> None:
    """Wait until result blocks or outbound links appear."""
    selectors = (
        "div.MjjYud",
        "div.g",
        "div[data-hveid]",
        "#search a[href^='http']",
        "#rso a[href^='http']",
        "#search a[href*='/url?q=']",
    )

    def _has_results(d):
        for sel in selectors:
            if d.find_elements(By.CSS_SELECTOR, sel):
                return True
        return False

    try:
        WebDriverWait(driver, timeout).until(_has_results)
    except Exception:
        pass
    time.sleep(0.4)


def _normalize_google_href(href: str) -> str:
    if not href:
        return ""
    try:
        p = urlparse(href)
        host = (p.netloc or "").lower()
        if "google." in host and p.path == "/url":
            q = parse_qs(p.query).get("q", [""])[0]
            if q:
                return unquote(q)
    except Exception:
        pass
    return href


def _extract_from_block(block) -> dict | None:
    try:
        link_el = None
        for sel in ("a[href^='http']", "a[jsname][href^='http']", "a[href*='/url?q=']"):
            els = block.find_elements(By.CSS_SELECTOR, sel)
            for el in els:
                href = el.get_attribute("href") or ""
                href = _normalize_google_href(href)
                if href and "google.com" not in href and "google." not in extract_domain_from_url(href):
                    link_el = el
                    break
            if link_el:
                break
        if not link_el:
            return None
        href = _normalize_google_href(link_el.get_attribute("href") or "")
        if not href or "google." in extract_domain_from_url(href):
            return None
        title = ""
        snippet = ""
        for sel in ("h3", "h3.LC20lb", "div[role='heading']"):
            try:
                title = block.find_element(By.CSS_SELECTOR, sel).text
                if title:
                    break
            except Exception:
                pass
        for sel in ("div[data-sncf]", "span[class*='st']", "div.VwiC3b", "div.IsZvec", "span.aCOpRe"):
            try:
                snippet = block.find_element(By.CSS_SELECTOR, sel).text
                if snippet:
                    break
            except Exception:
                pass
        return {
            "url": href,
            "domain": extract_domain_from_url(href),
            "title": title,
            "snippet": snippet,
        }
    except Exception:
        return None


def parse_serp(driver) -> list[dict]:
    results = []
    seen = set()

    block_selectors = (
        "div.g",
        "div[data-sokoban-container]",
        "div.Gx5Zad",
        "div.MjjYud",
        "div[data-hveid]",
    )
    blocks = []
    for sel in block_selectors:
        blocks.extend(driver.find_elements(By.CSS_SELECTOR, sel))

    for block in blocks:
        row = _extract_from_block(block)
        if row and row["url"] not in seen:
            seen.add(row["url"])
            results.append(row)

    if not results:
        for h3 in driver.find_elements(By.CSS_SELECTOR, "h3.LC20lb, #search h3, #rso h3"):
            try:
                title = (h3.text or "").strip()
                if not title:
                    continue
                link = None
                for xpath in ("./ancestor::a[1]", "./parent::a", "./following::a[1]"):
                    try:
                        link = h3.find_element(By.XPATH, xpath)
                        break
                    except Exception:
                        continue
                if not link:
                    continue
                href = _normalize_google_href(link.get_attribute("href") or "")
                if not href or "google." in extract_domain_from_url(href):
                    continue
                if href in seen:
                    continue
                seen.add(href)
                results.append({
                    "url": href,
                    "domain": extract_domain_from_url(href),
                    "title": title,
                    "snippet": "",
                })
            except Exception:
                continue

    if not results:
        link_selectors = (
            "#search a[href^='http']",
            "#rso a[href^='http']",
            "#search a[href*='/url?q=']",
            "#rso a[href*='/url?q=']",
        )
        for sel in link_selectors:
            for link in driver.find_elements(By.CSS_SELECTOR, sel):
                try:
                    href = _normalize_google_href(link.get_attribute("href") or "")
                    if not href or "google." in extract_domain_from_url(href):
                        continue
                    if href in seen:
                        continue
                    seen.add(href)
                    title = ""
                    try:
                        title = link.find_element(By.CSS_SELECTOR, "h3").text
                    except Exception:
                        title = link.text or ""
                    results.append({
                        "url": href,
                        "domain": extract_domain_from_url(href),
                        "title": title,
                        "snippet": "",
                    })
                except Exception:
                    continue
            if results:
                break

    return results
