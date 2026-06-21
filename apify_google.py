"""
Google site: indexing checker — Selenium + Chrome remote debugging.
Apify Google SERP proxy fallback when captcha is detected.

CAPTCHA strategies:
  apify  — close Chrome, process batch via Apify proxy, reopen Chrome (original behaviour)
  wait   — wait a configurable number of minutes, restart Chrome, retry Selenium indefinitely
"""

import json
import os
import queue
import random
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from bs4 import BeautifulSoup

import requests as req_lib
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException

app = Flask(__name__)
CORS(app)

results_queues = {}
scan_sessions = {}

# ── Chrome config ──────────────────────────────────────────────────────────────
CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_DEBUG_PORT = 9224
CHROME_USER_DATA = r"C:\ChromeDebugGIndex"
CHROME_PROFILE = "Default"

# ── Apify config ───────────────────────────────────────────────────────────────
APIFY_PROXY_PASSWORD = os.environ.get("APIFY_PROXY_PASSWORD")
APIFY_PROXY_HOST = "proxy.apify.com"
APIFY_PROXY_PORT = 8000
APIFY_PROXY_USERNAME = "groups-GOOGLE_SERP"

APIFY_BATCH_SIZE = 20
APIFY_DELAY_SEC = 10
APIFY_TIMEOUT_SEC = 30

# ── Misc constants ─────────────────────────────────────────────────────────────
CAPTCHA_MANUAL_WAIT_SEC = 120
CAPTCHA_POLL_SEC = 2
PROGRESS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan_progress.json")

# ── Regex ──────────────────────────────────────────────────────────────────────
GOOGLE_CAPTCHA_RE = re.compile(
    r"unusual traffic|automated queries|captcha|i'm not a robot|"
    r"verify you.{0,20}re not a robot|recaptcha|before you continue|"
    r"our systems have detected",
    re.I,
)

NO_RESULTS_RE = re.compile(
    r"did not match any documents|no results found for|"
    r"your search did not match|didn't match any|"
    r"aucun document ne correspond|aucun résultat",
    re.I,
)

RESULT_STATS_RE = re.compile(
    r"(?:about|environ|approximately|roughly)?\s*([\d][\d,\.]*)\s+results?",
    re.I,
)


# ══════════════════════════════════════════════════════════════════════════════
# Session
# ══════════════════════════════════════════════════════════════════════════════

class ScanSession:
    def __init__(self, session_id):
        self.session_id = session_id
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.row_counter = 0
        self.lock = threading.Lock()

    def next_row_index(self):
        with self.lock:
            self.row_counter += 1
            return self.row_counter

    def is_stopped(self):
        return self.stop_event.is_set()

    def wait_while_paused(self):
        while self.pause_event.is_set() and not self.stop_event.is_set():
            time.sleep(0.4)


# ══════════════════════════════════════════════════════════════════════════════
# Progress persistence
# ══════════════════════════════════════════════════════════════════════════════

def load_progress():
    if not os.path.isfile(PROGRESS_FILE):
        return {"completed": {}}
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "completed" not in data:
            data["completed"] = {}
        return data
    except Exception:
        return {"completed": {}}


def save_progress_entry(domain, payload):
    data = load_progress()
    data["completed"][domain] = {**payload, "savedAt": int(time.time())}
    try:
        with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[progress] Save failed: {e}")


def clear_progress_file():
    try:
        if os.path.isfile(PROGRESS_FILE):
            os.remove(PROGRESS_FILE)
    except Exception as e:
        print(f"[progress] Clear failed: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# Chrome helpers
# ══════════════════════════════════════════════════════════════════════════════

def is_chrome_debug_running(port=CHROME_DEBUG_PORT):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def launch_chrome_debug():
    cmd = [
        CHROME_EXE,
        f"--remote-debugging-port={CHROME_DEBUG_PORT}",
        f"--user-data-dir={CHROME_USER_DATA}",
        f"--profile-directory={CHROME_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
    ]
    flags = 0x00000008 | 0x00000200
    try:
        subprocess.Popen(
            cmd, creationflags=flags, close_fds=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("[chrome] Launched debug instance")
        return True
    except Exception as e:
        print(f"[chrome] Launch failed: {e}")
        return False


def ensure_chrome_ready():
    if is_chrome_debug_running():
        return True
    print("[chrome] Starting Chrome...")
    launch_chrome_debug()
    for _ in range(15):
        time.sleep(1)
        if is_chrome_debug_running():
            print("[chrome] Ready")
            return True
    return False


def kill_chrome_debug_listeners():
    if sys.platform != "win32":
        return
    try:
        out = subprocess.check_output(
            f"netstat -ano | findstr :{CHROME_DEBUG_PORT}",
            shell=True, text=True, stderr=subprocess.DEVNULL,
        )
        pids = set()
        for line in out.splitlines():
            if "LISTENING" in line:
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(parts[-1])
        for pid in pids:
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print(f"[chrome] Killed PID {pid} on port {CHROME_DEBUG_PORT}")
    except Exception as e:
        print(f"[chrome] kill listeners: {e}")
    time.sleep(2)


def restart_chrome_debug():
    print("[chrome] Restarting Chrome debug instance...")
    kill_chrome_debug_listeners()
    launch_chrome_debug()
    for _ in range(20):
        time.sleep(1)
        if is_chrome_debug_running():
            print("[chrome] Restart complete")
            return True
    print("[chrome] Restart failed — port not open")
    return False


def close_chrome_debug():
    print("[chrome] Closing Chrome (switching to Apify path)...")
    kill_chrome_debug_listeners()


def bring_chrome_to_front(driver=None):
    if driver:
        try:
            if driver.window_handles:
                driver.switch_to.window(driver.window_handles[-1])
            driver.execute_script("window.focus();")
        except Exception:
            pass
        try:
            driver.maximize_window()
        except Exception:
            pass

    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        SW_RESTORE = 9

        def callback(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd) + 1
            buf = ctypes.create_unicode_buffer(length)
            user32.GetWindowTextW(hwnd, buf, length)
            title = buf.value.lower()
            if "chrome" in title and (
                "google" in title or "search" in title or "captcha" in title or title.endswith("chrome")
            ):
                user32.ShowWindow(hwnd, SW_RESTORE)
                user32.SetForegroundWindow(hwnd)
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows(WNDENUMPROC(callback), 0)
    except Exception as e:
        print(f"[chrome] bring_to_front: {e}")


def get_driver():
    ensure_chrome_ready()
    options = Options()
    options.add_experimental_option("debuggerAddress", f"127.0.0.1:{CHROME_DEBUG_PORT}")
    return webdriver.Chrome(options=options)


# ══════════════════════════════════════════════════════════════════════════════
# URL / domain helpers
# ══════════════════════════════════════════════════════════════════════════════

def clean_domain(raw):
    d = raw.strip().lower()
    if d.startswith(("http://", "https://")):
        d = urllib.parse.urlparse(d).netloc or d
    d = d.split("/")[0].split("?")[0]
    return d.removeprefix("www.")


def google_search_url(domain):
    q = f"site:{domain}"
    params = urllib.parse.urlencode({"q": q, "hl": "en", "num": "100"})
    return f"https://www.google.com/search?{params}"


def google_search_url_http(domain):
    q = f"site:{domain}"
    params = urllib.parse.urlencode({"q": q, "num": 100, "hl": "en"})
    return f"http://www.google.com/search?{params}"


def ahrefs_url(domain):
    encoded = urllib.parse.quote(domain)
    return f"https://ahrefs.com/backlink-checker/?input={encoded}&mode=subdomains"


def enrich_payload(payload, session, resumed=False):
    if payload.get("rowIndex") is None:
        payload["rowIndex"] = session.next_row_index()
    payload["verifyUrl"] = payload.get("verifyUrl") or google_search_url(payload["domain"])
    payload["ahrefsUrl"] = ahrefs_url(payload["domain"])
    if resumed:
        payload["resumed"] = True
    return payload


# ══════════════════════════════════════════════════════════════════════════════
# APIFY path
# ══════════════════════════════════════════════════════════════════════════════

def _make_apify_proxies() -> dict:
    proxy_url = (
        f"http://{APIFY_PROXY_USERNAME}:{APIFY_PROXY_PASSWORD}"
        f"@{APIFY_PROXY_HOST}:{APIFY_PROXY_PORT}"
    )
    return {"http": proxy_url, "https": proxy_url}


APIFY_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    )
}


def _parse_apify_html(html: str, domain: str) -> dict:
    if not html:
        return {"indexed": False, "totalResults": 0, "firstPageCount": 0,
                "serpPages": 0, "singlePage": True}

    soup = BeautifulSoup(html, "html.parser")
    body_text = soup.get_text(" ", strip=True)

    if GOOGLE_CAPTCHA_RE.search(body_text):
        print(f"[apify] CAPTCHA/block detected in response for {domain}")
        return None

    if NO_RESULTS_RE.search(body_text):
        return {"indexed": False, "totalResults": 0, "firstPageCount": 0,
                "serpPages": 0, "singlePage": True}

    total = None
    for sel in ["#result-stats", ".LHJvCe"]:
        el = soup.select_one(sel)
        if el:
            m = RESULT_STATS_RE.search(el.get_text())
            if m:
                total = int(m.group(1).replace(",", "").replace(".", ""))
                break
    if total is None:
        m = RESULT_STATS_RE.search(body_text)
        if m:
            total = int(m.group(1).replace(",", "").replace(".", ""))

    domain_l = domain.lower()
    hosts = {domain_l, "www." + domain_l}
    first_page = 0
    for block in soup.select("#search div.g, #rso div.g, .MjjYud"):
        a = block.find("a", href=True)
        if not a:
            continue
        try:
            parsed = urllib.parse.urlparse(a["href"])
            host = parsed.netloc.lower().removeprefix("www.")
            if host in hosts or host.endswith("." + domain_l):
                first_page += 1
        except Exception:
            pass

    serp_pages = 1
    page_nums = set()
    for a in soup.select("table.AaVjTc a[aria-label]"):
        label = a.get("aria-label", "")
        m = re.search(r"Page\s+(\d+)", label, re.I)
        if m:
            page_nums.add(int(m.group(1)))
        txt = re.sub(r"\D", "", a.get_text())
        if txt:
            page_nums.add(int(txt))
    for td in soup.select("table.AaVjTc td.YyVfkd"):
        txt = re.sub(r"\D", "", td.get_text())
        if txt:
            page_nums.add(int(txt))
    if page_nums:
        serp_pages = max(page_nums)
    if soup.select_one("#pnnext, a[aria-label='Next page']") and serp_pages < 2:
        serp_pages = 2

    indexed = first_page > 0 or (total is not None and total > 0)
    if not indexed and re.search(r"\b0\s+results?\b", body_text, re.I):
        return {"indexed": False, "totalResults": 0, "firstPageCount": 0,
                "serpPages": 0, "singlePage": True}

    single_page = serp_pages <= 1
    if single_page and first_page > 0 and (total is None or total < first_page):
        total = first_page

    return {
        "indexed": indexed,
        "totalResults": total if total is not None else (first_page if indexed else 0),
        "firstPageCount": first_page,
        "serpPages": serp_pages if indexed else 0,
        "singlePage": single_page,
    }


def check_domain_via_apify(domain: str, session: ScanSession, result_queue: queue.Queue):
    if session.is_stopped():
        return "stopped"

    domain_clean = clean_domain(domain)
    url = google_search_url_http(domain_clean)
    print(f"[apify] Checking {domain_clean} via proxy...")

    html = None
    last_err = None

    for attempt in range(3):
        t0 = time.time()
        print(f"[apify] attempt {attempt+1}/3 — connecting...")
        try:
            resp = req_lib.get(
                "http://www.google.com/search",
                params={"q": f"site:{domain_clean}", "num": 100, "hl": "en"},
                headers=APIFY_HEADERS,
                proxies=_make_apify_proxies(),
                timeout=60,
                allow_redirects=True,
            )
            elapsed = time.time() - t0
            print(f"[apify] HTTP {resp.status_code} in {elapsed:.1f}s  body={len(resp.content):,} bytes")

            if resp.status_code == 429:
                last_err = "429 Too Many Requests"
                time.sleep(30)
                continue
            if resp.status_code in (407, 400):
                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                break

            resp.raise_for_status()
            html = resp.text
            break

        except req_lib.exceptions.Timeout:
            elapsed = time.time() - t0
            last_err = f"Timeout after {elapsed:.1f}s"
        except req_lib.exceptions.ProxyError as e:
            elapsed = time.time() - t0
            last_err = f"ProxyError after {elapsed:.1f}s: {e}"
        except Exception as e:
            elapsed = time.time() - t0
            last_err = f"{type(e).__name__} after {elapsed:.1f}s: {e}"

        if attempt < 2 and html is None:
            time.sleep(5)

    if html is None:
        payload = enrich_payload({
            "domain": domain_clean, "status": "error",
            "error": f"Apify proxy error: {last_err}",
            "verifyUrl": google_search_url(domain_clean), "path": "apify",
        }, session)
        save_progress_entry(domain_clean, payload)
        result_queue.put(payload)
        return "ok"

    parsed = _parse_apify_html(html, domain_clean)

    if parsed is None:
        payload = enrich_payload({
            "domain": domain_clean, "status": "error",
            "error": "Apify proxy returned CAPTCHA/block",
            "verifyUrl": google_search_url(domain_clean), "path": "apify",
        }, session)
        save_progress_entry(domain_clean, payload)
        result_queue.put(payload)
        return "blocked"

    payload = enrich_payload({
        "domain": domain_clean, "status": "ok",
        "indexed": parsed["indexed"],
        "totalResults": parsed["totalResults"],
        "firstPageCount": parsed["firstPageCount"],
        "serpPages": parsed["serpPages"],
        "singlePage": parsed["singlePage"],
        "verifyUrl": google_search_url(domain_clean), "path": "apify",
    }, session)

    if parsed["indexed"]:
        print(f"[apify] ✓ {domain_clean}: INDEXED (~{parsed['totalResults']} results)")
    else:
        print(f"[apify] ✗ {domain_clean}: NOT INDEXED")

    save_progress_entry(domain_clean, payload)
    result_queue.put(payload)
    return "ok"


def run_apify_batch(domains: list, session: ScanSession, result_queue: queue.Queue) -> list:
    remaining = []
    for i, domain in enumerate(domains):
        if session.is_stopped():
            remaining.extend(domains[i:])
            break

        session.wait_while_paused()
        outcome = check_domain_via_apify(domain, session, result_queue)

        if outcome == "blocked":
            remaining.extend(domains[i + 1:])
            print("[apify] Proxy blocked — returning remaining domains to Selenium queue")
            break

        if i < len(domains) - 1 and not session.is_stopped():
            print(f"[apify] Waiting {APIFY_DELAY_SEC}s before next domain...")
            for _ in range(APIFY_DELAY_SEC * 2):
                if session.is_stopped():
                    break
                session.wait_while_paused()
                time.sleep(0.5)

    return remaining


# ══════════════════════════════════════════════════════════════════════════════
# Wait-and-retry path  (new)
# ══════════════════════════════════════════════════════════════════════════════

def wait_and_retry_selenium(domain: str, wait_minutes: int, session: ScanSession,
                            result_queue: queue.Queue) -> str:
    """
    On CAPTCHA, close Chrome, wait `wait_minutes`, restart Chrome, retry Selenium.
    Loops indefinitely until the domain succeeds or the scan is stopped.
    Returns 'ok' | 'stopped'.
    """
    attempt = 0
    while True:
        attempt += 1
        wait_sec = wait_minutes * 60

        print(f"[wait-retry] CAPTCHA — waiting {wait_minutes} min before attempt {attempt} on {domain}")

        # Close Chrome to let Google cooldown
        close_chrome_debug()

        # Notify frontend with countdown
        result_queue.put({
            "domain": domain,
            "status": "captcha_waiting",
            "message": f"CAPTCHA — waiting {wait_minutes} min before retry #{attempt} on {domain}...",
        })

        # Interruptible sleep with live countdown messages every 60s
        elapsed = 0
        tick = 15  # send update every 15 s
        while elapsed < wait_sec:
            if session.is_stopped():
                return "stopped"
            session.wait_while_paused()
            sleep_chunk = min(tick, wait_sec - elapsed)
            time.sleep(sleep_chunk)
            elapsed += sleep_chunk
            remaining_min = max(0, (wait_sec - elapsed) / 60)
            if elapsed < wait_sec:
                result_queue.put({
                    "domain": domain,
                    "status": "captcha_waiting",
                    "message": (
                        f"CAPTCHA wait: {remaining_min:.1f} min remaining "
                        f"before retry #{attempt} on {domain}"
                    ),
                })

        if session.is_stopped():
            return "stopped"

        print(f"[wait-retry] Restarting Chrome for retry #{attempt} on {domain}")
        restart_chrome_debug()

        # Extra small jitter so we don't hit Google at the exact same second every time
        jitter = random.uniform(5, 20)
        print(f"[wait-retry] Jitter delay {jitter:.1f}s...")
        time.sleep(jitter)

        # Notify frontend
        result_queue.put({
            "domain": domain,
            "status": "captcha_waiting",
            "message": f"Retrying {domain} via Selenium (attempt #{attempt})...",
        })

        outcome = check_domain_selenium(domain, session, result_queue, restart_chrome=False)

        if outcome == "stopped":
            return "stopped"

        if outcome == "ok":
            # Success — clear captcha banner on frontend
            result_queue.put({"domain": domain, "status": "captcha_solved",
                              "message": f"Retry #{attempt} succeeded for {domain}"})
            return "ok"

        # outcome == 'captcha' again — loop and wait again
        print(f"[wait-retry] Still getting CAPTCHA on {domain} — will wait again")


# ══════════════════════════════════════════════════════════════════════════════
# Selenium CAPTCHA handling
# ══════════════════════════════════════════════════════════════════════════════

def is_google_captcha(driver):
    try:
        text = driver.find_element(By.TAG_NAME, "body").text[:5000]
    except Exception:
        text = ""
    if GOOGLE_CAPTCHA_RE.search(text):
        return True
    try:
        if driver.find_elements(
            By.CSS_SELECTOR,
            "iframe[src*='recaptcha'], #captcha-form, form#captcha, .g-recaptcha",
        ):
            return True
    except Exception:
        pass
    return False


def has_recaptcha_image_challenge(driver):
    driver.switch_to.default_content()
    try:
        for iframe in driver.find_elements(By.CSS_SELECTOR, "iframe[src*='bframe']"):
            if iframe.is_displayed():
                return True
    except Exception:
        pass
    return False


def _switch_default(driver):
    try:
        driver.switch_to.default_content()
    except Exception:
        pass


def click_recaptcha_checkbox(driver):
    _switch_default(driver)
    anchor_selectors = [
        "iframe[src*='recaptcha/api2/anchor']",
        "iframe[src*='google.com/recaptcha']",
        "iframe[title*='reCAPTCHA']",
    ]

    def try_click_in_context():
        selectors = [
            "#recaptcha-anchor", ".recaptcha-checkbox-border",
            ".rc-anchor-checkbox", "span.recaptcha-checkbox", "div.rc-anchor-content",
        ]
        for sel in selectors:
            try:
                el = WebDriverWait(driver, 3).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, sel))
                )
                driver.execute_script("arguments[0].click();", el)
                return True
            except (TimeoutException, NoSuchElementException):
                continue
        return False

    for iframe_sel in anchor_selectors:
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, iframe_sel)
            for frame in frames:
                try:
                    driver.switch_to.frame(frame)
                    if try_click_in_context():
                        _switch_default(driver)
                        print("[captcha] Clicked reCAPTCHA anchor checkbox")
                        time.sleep(2)
                        return True
                except Exception:
                    pass
                finally:
                    _switch_default(driver)
        except Exception:
            _switch_default(driver)

    _switch_default(driver)
    try:
        for outer in driver.find_elements(By.CSS_SELECTOR, "iframe[src*='recaptcha']"):
            driver.switch_to.frame(outer)
            try:
                inners = driver.find_elements(By.TAG_NAME, "iframe")
                for inner in inners:
                    src = (inner.get_attribute("src") or "").lower()
                    if "anchor" in src or "api2" in src:
                        driver.switch_to.frame(inner)
                        if try_click_in_context():
                            _switch_default(driver)
                            print("[captcha] Clicked nested reCAPTCHA checkbox")
                            time.sleep(2)
                            return True
                        driver.switch_to.parent_frame()
            except Exception:
                pass
            finally:
                _switch_default(driver)
    except Exception:
        _switch_default(driver)

    print("[captcha] Could not find reCAPTCHA checkbox in iframes")
    return False


def captcha_cleared(driver):
    return not is_google_captcha(driver) and not has_recaptcha_image_challenge(driver)


# ══════════════════════════════════════════════════════════════════════════════
# Selenium SERP parsing
# ══════════════════════════════════════════════════════════════════════════════

def parse_result_stats(driver):
    selectors = ["#result-stats", ".LHJvCe", "[id='result-stats']"]
    for sel in selectors:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            m = RESULT_STATS_RE.search(el.text.strip())
            if m:
                return int(m.group(1).replace(",", "").replace(".", ""))
        except NoSuchElementException:
            continue
    try:
        m = RESULT_STATS_RE.search(driver.find_element(By.TAG_NAME, "body").text)
        if m:
            return int(m.group(1).replace(",", "").replace(".", ""))
    except Exception:
        pass
    return None


def count_organic_results(driver, domain):
    domain_l = domain.lower()
    script = """
    const domain = arguments[0];
    const hosts = new Set([domain, 'www.' + domain]);
    const blocks = document.querySelectorAll('#search div.g, #rso div.g, .MjjYud');
    let n = 0;
    for (const block of blocks) {
        const link = block.querySelector('a[href^="http"]');
        if (!link) continue;
        try {
            const u = new URL(link.href);
            const host = u.hostname.replace(/^www\\./, '');
            if (hosts.has(host) || host.endsWith('.' + domain)) n++;
        } catch (e) {}
    }
    return n;
    """
    try:
        count = driver.execute_script(script, domain_l) or 0
        if count > 0:
            return count
    except Exception:
        pass
    count = 0
    try:
        for block in driver.find_elements(By.CSS_SELECTOR, "#search div.g h3, #rso div.g h3"):
            if block.is_displayed():
                count += 1
    except Exception:
        pass
    return count


def parse_google_pagination(driver):
    script = """
    const result = { serpPages: 1, currentPage: 1, hasNext: false };
    const table = document.querySelector('table.AaVjTc');
    if (!table) return result;
    const pageNums = new Set();
    table.querySelectorAll('td.YyVfkd').forEach(td => {
        const n = parseInt(td.innerText.replace(/\\D/g, ''), 10);
        if (!isNaN(n) && n > 0) { pageNums.add(n); result.currentPage = n; }
    });
    table.querySelectorAll('a[aria-label^="Page"]').forEach(a => {
        const label = a.getAttribute('aria-label') || '';
        const m = label.match(/Page\\s+(\\d+)/i);
        if (m) pageNums.add(parseInt(m[1], 10));
        const n = parseInt(a.innerText.replace(/\\D/g, ''), 10);
        if (!isNaN(n) && n > 0) pageNums.add(n);
    });
    table.querySelectorAll('td.NKTSme a.fl').forEach(a => {
        const n = parseInt(a.innerText.replace(/\\D/g, ''), 10);
        if (!isNaN(n) && n > 0) pageNums.add(n);
    });
    if (pageNums.size > 0) result.serpPages = Math.max(...pageNums);
    const next = document.querySelector('#pnnext, a[aria-label="Next page"]');
    if (next) { result.hasNext = true; if (result.serpPages < 2) result.serpPages = 2; }
    return result;
    """
    try:
        data = driver.execute_script(script) or {}
        serp_pages = int(data.get("serpPages") or 1)
        current = int(data.get("currentPage") or 1)
        has_next = bool(data.get("hasNext"))
        if has_next and serp_pages < 2:
            serp_pages = 2
        return {"serpPages": max(1, serp_pages), "currentPage": max(1, current), "hasNext": has_next}
    except Exception as e:
        print(f"[pagination] parse error: {e}")
        return {"serpPages": 1, "currentPage": 1, "hasNext": False}


def parse_serp(driver, domain):
    body = ""
    try:
        body = driver.find_element(By.TAG_NAME, "body").text
    except Exception:
        pass

    if NO_RESULTS_RE.search(body):
        return {"indexed": False, "totalResults": 0, "firstPageCount": 0,
                "serpPages": 0, "singlePage": True}

    first_page = count_organic_results(driver, domain)
    total = parse_result_stats(driver)
    pagination = parse_google_pagination(driver)
    serp_pages = pagination["serpPages"]

    if total is None and first_page > 0:
        total = 1 if re.search(r"\b1\s+result\b", body, re.I) else first_page

    indexed = first_page > 0 or (total is not None and total > 0)

    if not indexed and re.search(r"\b0\s+results?\b", body, re.I):
        return {"indexed": False, "totalResults": 0, "firstPageCount": 0,
                "serpPages": 0, "singlePage": True}

    single_page = serp_pages <= 1
    if single_page and first_page > 0 and (total is None or total < first_page):
        total = first_page

    return {
        "indexed": indexed,
        "totalResults": total if total is not None else (first_page if indexed else 0),
        "firstPageCount": first_page,
        "serpPages": serp_pages if indexed else 0,
        "singlePage": single_page,
    }


def wait_for_serp(driver, session, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        if session.is_stopped():
            return "stopped"
        session.wait_while_paused()
        if is_google_captcha(driver) or has_recaptcha_image_challenge(driver):
            return "captcha"
        try:
            if "google.com/search" not in (driver.current_url or ""):
                time.sleep(0.4)
                continue
            body = driver.find_element(By.TAG_NAME, "body").text
            if NO_RESULTS_RE.search(body) or RESULT_STATS_RE.search(body):
                return "ready"
            if driver.find_elements(By.CSS_SELECTOR, "#search div.g, #rso div.g, .MjjYud"):
                return "ready"
        except Exception:
            pass
        time.sleep(0.4)
    return "timeout"


# ══════════════════════════════════════════════════════════════════════════════
# Selenium single-domain check
# ══════════════════════════════════════════════════════════════════════════════

def check_domain_selenium(domain, session, result_queue, restart_chrome=False):
    """Returns: 'ok' | 'captcha' | 'stopped'"""
    driver = None
    domain_clean = clean_domain(domain)

    try:
        if session.is_stopped():
            return "stopped"

        print(f"\n{'='*60}\n[selenium] {domain_clean}\n{'='*60}")
        if restart_chrome:
            restart_chrome_debug()
        driver = get_driver()
        url = google_search_url(domain_clean)
        driver.get(url)
        human_delay(2.0, 4.0)

        if is_google_captcha(driver) or has_recaptcha_image_challenge(driver):
            print(f"[selenium] CAPTCHA detected on {domain_clean}")
            return "captcha"

        state = wait_for_serp(driver, session)
        if state == "stopped":
            return "stopped"
        if state == "captcha":
            print(f"[selenium] CAPTCHA during wait for {domain_clean}")
            return "captcha"

        if session.is_stopped():
            return "stopped"

        parsed = parse_serp(driver, domain_clean)
        payload = enrich_payload({
            "domain": domain_clean, "status": "ok",
            "indexed": parsed["indexed"],
            "totalResults": parsed["totalResults"],
            "firstPageCount": parsed["firstPageCount"],
            "serpPages": parsed["serpPages"],
            "singlePage": parsed["singlePage"],
            "verifyUrl": google_search_url(domain_clean), "path": "selenium",
        }, session)

        if parsed["indexed"]:
            print(f"[selenium] ✓ {domain_clean}: INDEXED (~{parsed['totalResults']} results)")
        else:
            print(f"[selenium] ✗ {domain_clean}: NOT INDEXED")

        save_progress_entry(domain_clean, payload)
        result_queue.put(payload)
        return "ok"

    except Exception as e:
        print(f"[selenium] Error {domain_clean}: {e}")
        import traceback
        traceback.print_exc()
        payload = enrich_payload({
            "domain": domain_clean, "status": "error", "error": str(e),
            "verifyUrl": google_search_url(domain_clean), "path": "selenium",
        }, session)
        save_progress_entry(domain_clean, payload)
        result_queue.put(payload)
        return "ok"
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


def human_delay(min_s=1.2, max_s=2.8):
    time.sleep(random.uniform(min_s, max_s))


# ══════════════════════════════════════════════════════════════════════════════
# Main processing loop
# ══════════════════════════════════════════════════════════════════════════════

def process_domains(domains, session_id, captcha_strategy, captcha_wait_min, resume):
    """
    captcha_strategy: 'apify'  → switch to Apify proxy batch (original behaviour)
                      'wait'   → close Chrome, wait captcha_wait_min minutes, restart, retry loop
    """
    q = results_queues[session_id]
    session = scan_sessions[session_id]
    progress = load_progress() if resume else {"completed": {}}
    completed = progress.get("completed", {})

    to_process = []
    for raw in domains:
        d = clean_domain(raw)
        if not d:
            continue
        if resume and d in completed:
            cached = dict(completed[d])
            cached["domain"] = d
            cached["status"] = cached.get("status", "ok")
            cached.pop("rowIndex", None)
            cached.pop("savedAt", None)
            enrich_payload(cached, session, resumed=True)
            q.put(cached)
            print(f"[resume] Skipping {d} (already done)")
        else:
            to_process.append(d)

    i = 0
    selenium_inter_delay = (4, 8)

    while i < len(to_process):
        if session.is_stopped():
            q.put({"status": "stopped", "message": "Scan stopped by user"})
            break

        session.wait_while_paused()
        domain = to_process[i]

        outcome = check_domain_selenium(domain, session, q)

        if outcome == "stopped":
            q.put({"status": "stopped", "message": "Scan stopped by user"})
            break

        if outcome == "captcha":
            # ── Notify frontend ────────────────────────────────────────────
            q.put({
                "domain": domain,
                "status": "captcha",
                "message": (
                    f"CAPTCHA on {domain} — "
                    + ("switching to Apify proxy" if captcha_strategy == "apify"
                       else f"waiting {captcha_wait_min} min before retry")
                ),
            })

            if captcha_strategy == "apify":
                # ── APIFY PATH (original) ──────────────────────────────────
                close_chrome_debug()
                batch = to_process[i: i + APIFY_BATCH_SIZE]
                print(f"[apify] Starting batch of {len(batch)} domain(s)")
                not_processed = run_apify_batch(batch, session, q)
                processed_count = len(batch) - len(not_processed)
                i += processed_count

                if session.is_stopped():
                    q.put({"status": "stopped", "message": "Scan stopped by user"})
                    break

                if i < len(to_process):
                    print("[chrome] Re-opening Chrome after Apify batch...")
                    restart_chrome_debug()
                    cooldown = random.uniform(8, 15)
                    print(f"[chrome] Post-Apify cooldown {cooldown:.1f}s...")
                    for _ in range(int(cooldown * 2)):
                        if session.is_stopped():
                            break
                        session.wait_while_paused()
                        time.sleep(0.5)

                q.put({"domain": domain, "status": "captcha_solved",
                       "message": "Switched to Apify — captcha bypassed"})
                continue  # i already advanced inside batch logic

            else:
                # ── WAIT & RETRY PATH (new) ────────────────────────────────
                outcome2 = wait_and_retry_selenium(domain, captcha_wait_min, session, q)
                if outcome2 == "stopped":
                    q.put({"status": "stopped", "message": "Scan stopped by user"})
                    break
                # outcome2 == 'ok' means domain was eventually processed inside the loop
                i += 1
                continue

        # outcome == 'ok'
        i += 1

        if i < len(to_process) and not session.is_stopped():
            delay = random.uniform(*selenium_inter_delay)
            print(f"[queue] Waiting {delay:.1f}s before next domain...")
            for _ in range(int(delay * 2)):
                if session.is_stopped():
                    break
                session.wait_while_paused()
                time.sleep(0.5)

    q.put(None)
    scan_sessions.pop(session_id, None)


# ══════════════════════════════════════════════════════════════════════════════
# Flask API
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/check", methods=["POST"])
def check_domains():
    data = request.json or {}
    raw = data.get("domains", "")
    domains = [d.strip() for d in re.split(r"[\s,\n]+", raw) if d.strip()]
    if not domains:
        return jsonify({"error": "No domains provided"}), 400

    captcha_strategy = data.get("captchaStrategy", "apify")
    if captcha_strategy not in ("apify", "wait"):
        captcha_strategy = "apify"

    captcha_wait_min = int(data.get("captchaWaitMin", 10))
    if captcha_wait_min not in (5, 10, 20):
        captcha_wait_min = 10

    resume = data.get("resume", True)

    session_id = str(int(time.time() * 1000))
    results_queues[session_id] = queue.Queue()
    scan_sessions[session_id] = ScanSession(session_id)

    skipped = 0
    if resume:
        completed = load_progress().get("completed", {})
        skipped = sum(1 for d in domains if clean_domain(d) in completed)

    threading.Thread(
        target=process_domains,
        args=(domains, session_id, captcha_strategy, captcha_wait_min, resume),
        daemon=True,
    ).start()

    return jsonify({"session_id": session_id, "total": len(domains), "skippedResume": skipped})


@app.route("/session/<session_id>/pause", methods=["POST"])
def pause_session(session_id):
    session = scan_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found or finished"}), 404
    session.pause_event.set()
    return jsonify({"status": "paused"})


@app.route("/session/<session_id>/resume", methods=["POST"])
def resume_session(session_id):
    session = scan_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found or finished"}), 404
    session.pause_event.clear()
    return jsonify({"status": "running"})


@app.route("/session/<session_id>/stop", methods=["POST"])
def stop_session(session_id):
    session = scan_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found or finished"}), 404
    session.stop_event.set()
    session.pause_event.clear()
    return jsonify({"status": "stopping"})


@app.route("/progress", methods=["GET"])
def get_progress():
    data = load_progress()
    return jsonify({"count": len(data.get("completed", {})), "domains": list(data.get("completed", {}).keys())})


@app.route("/progress", methods=["DELETE"])
def delete_progress():
    clear_progress_file()
    return jsonify({"status": "cleared"})


@app.route("/stream/<session_id>")
def stream_results(session_id):
    if session_id not in results_queues:
        return jsonify({"error": "Invalid session"}), 404

    def generate():
        q = results_queues[session_id]
        while True:
            item = q.get()
            if item is None:
                yield f"data: {json.dumps({'done': True})}\n\n"
                break
            yield f"data: {json.dumps(item)}\n\n"
        results_queues.pop(session_id, None)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "chrome_debug": is_chrome_debug_running(),
        "port": CHROME_DEBUG_PORT,
        "apify_proxy_configured": APIFY_PROXY_PASSWORD != "YOUR_APIFY_PROXY_PASSWORD_HERE",
    })


if __name__ == "__main__":
    print("""
    ╔══════════════════════════════════════════════════════════════════╗
    ║     Google Indexing Checker  (Selenium + Apify / Wait-retry)    ║
    ╠══════════════════════════════════════════════════════════════════╣
    ║  API:            http://localhost:5001                           ║
    ║  Progress:       scan_progress.json  (resume)                   ║
    ║  CAPTCHA apify:  batch 20 domains @ 10s/domain                  ║
    ║  CAPTCHA wait:   configurable 5/10/20 min then Selenium retry   ║
    ╚══════════════════════════════════════════════════════════════════╝
    """)
    app.run(debug=False, port=5001, threaded=True, host="0.0.0.0")