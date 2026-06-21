#!/usr/bin/env python3
"""Processor runner — reads JSON from stdin, writes JSON to stdout."""
import json
import os
import sys

from processors.chrome import release_driver
from processors import google_serp, linkedin, instagram, zfbot, crunchbase, contact_scraper

HANDLERS = {
    "google_serp": google_serp.run,
    "linkedin": linkedin.run,
    "instagram": instagram.run,
    "zfbot": zfbot.run,
    "crunchbase": crunchbase.run,
    "contact_scrape": contact_scraper.run,
}


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    step = payload.get("step", "")
    handler = HANDLERS.get(step)
    if not handler:
        print(json.dumps({"ok": False, "error": f"unknown step: {step}"}), flush=True)
        release_driver()
        os._exit(0)

    try:
        result = handler(payload)
        print(json.dumps(result), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
    finally:
        release_driver()
        # Force exit — Selenium chromedriver cleanup can hang with debuggerAddress.
        os._exit(0)


if __name__ == "__main__":
    main()
