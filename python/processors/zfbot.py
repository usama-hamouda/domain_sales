"""ZFBot related domain finder — auto-login when credentials are provided."""
import os
import re
import json
import sys
import time
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from .chrome import get_driver, safe_get, navigate


def _log(msg: str):
    print(f"[zfbot] {msg}", file=sys.stderr, flush=True)


def zf_inputs(raw_sld: str) -> dict:
    full = (raw_sld or "").split(".")[0].strip().lower()
    if not full:
        return {"dom_s": "", "dom_e": ""}
    raw = (raw_sld or "").split(".")[0].strip()
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    segs = [s.lower() for s in re.split(r"[^a-zA-Z0-9]+", spaced) if len(s) > 2]
    if len(segs) >= 2:
        return {"dom_s": segs[0], "dom_e": segs[-1]}
    return {"dom_s": full, "dom_e": ""}


def parse_zfbot_script(text: str) -> list:
    m = re.search(r"var\s+result\s*=\s*(\[[\s\S]*?\])\s*;", text or "")
    if not m:
        return []
    try:
        d = json.loads(m.group(1))
        return d if isinstance(d, list) else []
    except Exception as e:
        _log(f"JSON parse error: {e}")
        return []


def _has_search_form(driver) -> bool:
    return bool(driver.find_elements(By.CSS_SELECTOR, "#dom_s"))


def _try_login(driver, email: str, password: str) -> bool:
    if not email or not password:
        return False

    _log("Attempting ZFBot login")
    if not safe_get(driver, "https://zfbot.com/", retries=2, wait=1.0):
        return False

    try:
        wait = WebDriverWait(driver, 8)
        email_el = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'input[name="email"]')))
        pass_el = driver.find_element(By.CSS_SELECTOR, 'input[name="password"]')
        email_el.clear()
        email_el.send_keys(email)
        pass_el.clear()
        pass_el.send_keys(password)
        driver.find_element(By.CSS_SELECTOR, 'button[name="login"][type="submit"]').click()
        time.sleep(1.2)
    except Exception as e:
        _log(f"Login form submit failed: {e}")
        return False

    try:
        WebDriverWait(driver, 12).until(lambda d: _has_search_form(d) or "main.php" in (d.current_url or ""))
    except Exception:
        pass

    if not _has_search_form(driver):
        navigate(driver, "https://zfbot.com/main.php")
        time.sleep(0.8)

    if _has_search_form(driver):
        _log("Login successful")
        return True

    _log("Login did not reach search form")
    return False


def _ensure_logged_in(driver, email: str, password: str) -> bool:
    if _has_search_form(driver):
        _log("Already logged in")
        return True
    if _try_login(driver, email, password):
        return True
    _log("Waiting briefly for manual ZFBot login")
    try:
        WebDriverWait(driver, 30).until(lambda d: _has_search_form(d))
        return True
    except Exception:
        return False


def run(payload: dict) -> dict:
    domain = payload.get("domain", "")
    raw_sld = (domain or "").split(".")[0]
    dom_in = zf_inputs(raw_sld)
    email = payload.get("zfbot_email") or os.environ.get("ZFBOT_EMAIL", "")
    password = payload.get("zfbot_password") or os.environ.get("ZFBOT_PASSWORD", "")

    _log(f"Starting for {domain} (dom_s={dom_in['dom_s']!r}, dom_e={dom_in['dom_e']!r})")

    driver = get_driver()
    wait = WebDriverWait(driver, 12)

    try:
        _log("Navigating to zfbot.com/main.php")
        if not safe_get(driver, "https://zfbot.com/main.php", retries=2, wait=1.0):
            return {"ok": False, "error": "navigation_failed", "results": [], **dom_in}

        if not _ensure_logged_in(driver, email, password):
            return {"ok": False, "error": "zfbot_not_logged_in", "results": [], **dom_in}

        for toggle_id in ("cmn-toggle-dashes", "cmn-toggle-nums"):
            try:
                el = driver.find_element(By.ID, toggle_id)
                inp = el if el.tag_name == "input" else el.find_element(By.CSS_SELECTOR, "input")
                if not inp.is_selected():
                    inp.click()
            except Exception:
                pass

        dom_s = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "#dom_s")))
        dom_s.clear()
        dom_s.send_keys(dom_in["dom_s"])
        dom_e = driver.find_element(By.CSS_SELECTOR, "#dom_e")
        dom_e.clear()
        dom_e.send_keys(dom_in.get("dom_e", ""))

        _log("Submitting search")
        driver.find_element(By.CSS_SELECTOR, "#searchit").click()
        time.sleep(1.5)

        body_text = driver.page_source
        raw_list = parse_zfbot_script(body_text)

        if not raw_list:
            _log("WARNING: no 'var result = [...]' found in page")

        results = []
        for row in raw_list:
            d = row.get("domain", "")
            ext = row.get("ext", "")
            full = f"{d}.{ext}" if d and ext else d
            if not full:
                continue
            results.append({
                "domain": full,
                "title": row.get("words", "") or full,
                "snippet": json.dumps(row) if isinstance(row, dict) else str(row),
                "url": f"https://{full}",
                "match_type": "zfbot",
                "extra": row,
            })

        _log(f"Done — {len(results)} domains found")
        return {"ok": True, "results": results, **dom_in}
    except Exception as e:
        _log(f"ERROR: {e}")
        return {"ok": False, "error": str(e), "results": [], **dom_in}
