"""Connect to Chrome running in remote debug mode."""
import os
import sys
import time
import subprocess
import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

CHROME_PORT = int(os.environ.get("CHROME_DEBUG_PORT", "9223"))
CHROME_EXE = os.environ.get(
    "CHROME_EXE",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
)
CHROME_USER_DATA = os.environ.get("CHROME_USER_DATA", r"C:\ChromeDebug")
CHROME_PROFILE = os.environ.get("CHROME_PROFILE", "Default")
PROCESSOR_TAB_FILE = os.path.join(CHROME_USER_DATA, ".processor_tab")

_active_driver = None


def _log(msg: str):
    print(f"[chrome] {msg}", file=sys.stderr, flush=True)


def is_debug_running() -> bool:
    try:
        r = requests.get(f"http://127.0.0.1:{CHROME_PORT}/json/version", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def wait_for_debug_port(timeout: float = 30) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_debug_running():
            return True
        time.sleep(0.5)
    return False


def launch_chrome():
    if not os.path.exists(CHROME_EXE):
        raise RuntimeError(f"Chrome not found: {CHROME_EXE}")
    profile_path = os.path.join(CHROME_USER_DATA, CHROME_PROFILE)
    os.makedirs(profile_path, exist_ok=True)
    args = [
        CHROME_EXE,
        f"--remote-debugging-port={CHROME_PORT}",
        f"--user-data-dir={CHROME_USER_DATA}",
        f"--profile-directory={CHROME_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=ChromeWhatsNew,SignInPromo,SyncPromo,ProfilePicker",
    ]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_for_debug_port(25):
        raise RuntimeError(f"Chrome debug port {CHROME_PORT} not available")


def _read_saved_tab() -> str | None:
    try:
        if not os.path.isfile(PROCESSOR_TAB_FILE):
            return None
        handle = open(PROCESSOR_TAB_FILE, encoding="utf-8").read().strip()
        return handle or None
    except Exception:
        return None


def _save_tab(driver) -> None:
    try:
        os.makedirs(CHROME_USER_DATA, exist_ok=True)
        with open(PROCESSOR_TAB_FILE, "w", encoding="utf-8") as f:
            f.write(driver.current_window_handle)
    except Exception as e:
        _log(f"save tab handle failed: {e}")


def _open_page_tab(driver):
    try:
        driver.switch_to.new_window("tab")
        return
    except Exception as e:
        _log(f"new_window failed: {e}")
    try:
        before = set(driver.window_handles)
        driver.execute_script("window.open('about:blank','_blank');")
        time.sleep(0.5)
        after = driver.window_handles
        for handle in after:
            if handle not in before:
                driver.switch_to.window(handle)
                return
        if after:
            driver.switch_to.window(after[-1])
    except Exception as e:
        _log(f"window.open fallback failed: {e}")


def _is_usable_tab(driver, handle: str) -> bool:
    try:
        driver.switch_to.window(handle)
        url = (driver.current_url or "").lower()
    except Exception:
        return False
    return not url.startswith("devtools:") and not url.startswith("chrome-extension:")


def _focus_front(driver) -> None:
    try:
        driver.execute_cdp_cmd("Page.bringToFront", {})
    except Exception:
        pass
    try:
        driver.execute_script("window.focus();")
    except Exception:
        pass


def ensure_page_tab(driver) -> None:
    """Reuse one processor tab across steps so navigation stays visible."""
    saved = _read_saved_tab()
    if saved and saved in driver.window_handles and _is_usable_tab(driver, saved):
        driver.switch_to.window(saved)
        _focus_front(driver)
        _save_tab(driver)
        return

    working = []
    for handle in driver.window_handles:
        if _is_usable_tab(driver, handle):
            working.append(handle)

    if working:
        driver.switch_to.window(working[-1])
    else:
        _open_page_tab(driver)

    _focus_front(driver)
    _save_tab(driver)


def prepare_browser(driver) -> None:
    ensure_page_tab(driver)


def navigate(driver, url: str) -> None:
    """Navigate the shared visible processor tab."""
    ensure_page_tab(driver)
    driver.get(url)
    time.sleep(0.2)
    _focus_front(driver)
    _save_tab(driver)


def safe_get(driver, url: str, retries: int = 3, wait: float = 2.0) -> bool:
    last_url = ""
    for attempt in range(retries):
        try:
            navigate(driver, url)
        except Exception as e:
            _log(f"safe_get error (attempt {attempt + 1}/{retries}): {e}")
            ensure_page_tab(driver)
        time.sleep(wait + attempt * 0.5)
        try:
            current = (driver.current_url or "").lower()
        except Exception:
            ensure_page_tab(driver)
            continue
        last_url = current
        if current not in ("about:blank", "") and not current.startswith("chrome://"):
            _focus_front(driver)
            return True
        _log(f"safe_get still on {current!r}, retrying")
    _log(f"safe_get failed for {url} (last url={last_url!r})")
    return False


def get_driver():
    """Attach Selenium to the shared Chrome debug session (retries on cold start)."""
    if not wait_for_debug_port(25):
        _log("Debug port not up — launching Chrome")
        launch_chrome()
        if not wait_for_debug_port(25):
            raise RuntimeError(f"Chrome debug port {CHROME_PORT} not available")

    time.sleep(1)

    opts = Options()
    opts.add_experimental_option("debuggerAddress", f"127.0.0.1:{CHROME_PORT}")

    last_err = None
    for attempt in range(8):
        try:
            service = Service()
            driver = webdriver.Chrome(service=service, options=opts)
            ensure_page_tab(driver)
            global _active_driver
            _active_driver = driver
            return driver
        except Exception as e:
            last_err = e
            _log(f"Driver attach attempt {attempt + 1}/8 failed: {e}")
            time.sleep(1.5 * (attempt + 1))

    raise RuntimeError(f"Unable to attach Selenium to Chrome on port {CHROME_PORT}: {last_err}")


def release_driver(driver=None):
    """Detach chromedriver without closing the shared Chrome browser."""
    global _active_driver
    driver = driver or _active_driver
    if driver:
        try:
            _save_tab(driver)
        except Exception:
            pass
    _active_driver = None
    if not driver:
        return
    try:
        service = getattr(driver, "service", None)
        proc = getattr(service, "process", None) if service else None
        if proc:
            try:
                proc.kill()
            except Exception:
                pass
        if service:
            service.process = None
    except Exception:
        pass
