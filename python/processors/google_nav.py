"""Simple Google SERP navigation — direct search URLs, no geo targeting."""
import sys
import time
import random
import urllib.parse
from .chrome import navigate
from .google_captcha import is_captcha_page, wait_for_captcha_resolution
from .google_consent import dismiss_google_consent
from .serp_parse import parse_serp, wait_for_serp


def _log(msg: str):
    print(f"[google_nav] {msg}", file=sys.stderr, flush=True)


def build_search_url(query: str, start: int = 0) -> str:
    url = f"https://www.google.com/search?q={urllib.parse.quote(query)}&hl=en&gl=us&lr=lang_en"
    if start > 0:
        url += f"&start={start}"
    return url


def _scroll_serp(driver) -> None:
    try:
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(0.4)
    except Exception:
        pass


def iter_google_pages(driver, query: str, max_pages: int, context: str = "google", state: dict | None = None):
    """Yield (page_index, results) for each Google results page."""
    if state is None:
        state = {}

    for page in range(max_pages):
        navigate(driver, build_search_url(query, page * 10))
        time.sleep(2 + random.random() * 2)
        dismiss_google_consent(driver)

        if is_captcha_page(driver):
            state["captcha_encountered"] = True
            wait_for_captcha_resolution(driver, f"{context} page {page + 1}")

        wait_for_serp(driver)
        _scroll_serp(driver)
        results = parse_serp(driver)

        if not results:
            _log(
                f"{context} page {page + 1}: 0 parsed results "
                f"(url={driver.current_url!r}, title={driver.title!r})"
            )

        if not results and is_captcha_page(driver):
            state["captcha_encountered"] = True
            wait_for_captcha_resolution(driver, f"{context} page {page + 1} (empty)")
            wait_for_serp(driver)
            results = parse_serp(driver)

        yield page, results

        # Stop paging when this page has no organic results (unless blocked by CAPTCHA).
        if not results and not is_captcha_page(driver):
            _log(f"{context}: stopping pagination — page {page + 1} returned no results")
            break
