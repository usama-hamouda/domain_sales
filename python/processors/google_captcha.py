"""Detect Google CAPTCHA / unusual-traffic pages and wait for manual resolution."""
import sys
import time
from selenium.webdriver.common.by import By

CAPTCHA_WAIT_SEC = 600
POLL_INTERVAL_SEC = 15


def is_captcha_page(driver) -> bool:
    try:
        url = (driver.current_url or "").lower()
        if "/sorry/" in url or "google.com/sorry" in url:
            return True
        title = (driver.title or "").lower()
        if "unusual traffic" in title or "before you continue" in title:
            return True
        src = (driver.page_source or "").lower()
        markers = (
            "our systems have detected unusual traffic",
            "detected unusual traffic from your computer network",
            "recaptcha",
            "captcha-form",
            "id=\"captcha\"",
            "unusual traffic from your computer",
        )
        if any(m in src for m in markers):
            if driver.find_elements(By.CSS_SELECTOR, "#captcha-form, form#captcha, iframe[src*='recaptcha']"):
                return True
            if "/sorry/" in url or "unusual traffic" in src[:5000]:
                return True
    except Exception:
        pass
    return False


def wait_for_captcha_resolution(driver, context: str = "google") -> bool:
    round_num = 0
    while is_captcha_page(driver):
        round_num += 1
        print(
            f"[captcha] {context}: CAPTCHA detected — pausing up to 10 min for manual solve (round {round_num})",
            file=sys.stderr,
            flush=True,
        )
        deadline = time.time() + CAPTCHA_WAIT_SEC
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_SEC)
            if not is_captcha_page(driver):
                print(f"[captcha] {context}: resolved, continuing", file=sys.stderr, flush=True)
                return True
        print(f"[captcha] {context}: still blocked after 10 min — retrying", file=sys.stderr, flush=True)
    return not is_captcha_page(driver)
