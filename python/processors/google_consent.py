"""Dismiss Google cookie / consent interstitials."""
import time
from selenium.webdriver.common.by import By


def dismiss_google_consent(driver) -> bool:
    selectors = (
        "button#L2AGLb",
        "button[aria-label*='Accept all']",
        "button[aria-label*='Accept']",
        "form[action*='consent'] button",
        "button.tC67Y",
        "div.QS5gu button",
    )
    for sel in selectors:
        try:
            for btn in driver.find_elements(By.CSS_SELECTOR, sel):
                if not btn.is_displayed():
                    continue
                btn.click()
                time.sleep(0.8)
                return True
        except Exception:
            continue
    return False
