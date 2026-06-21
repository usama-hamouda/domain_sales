"""Google SERP processor — searches brand words across multiple query strategies."""
import sys
import time

from .chrome import get_driver, release_driver
from .domain_utils import (
    derive_words,
    split_domain_words,
    classify_google_result,
    classify_other_path_result,
    build_google_search_queries,
)
from .google_nav import iter_google_pages
from .google_apify import search_google_via_apify


def _log(msg: str) -> None:
    print(f"[google_serp] {msg}", file=sys.stderr, flush=True)


def _format_duration(sec: float) -> str:
    sec = max(0, int(sec))
    hours, rem = divmod(sec, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def _step_budget_remaining(step_started: float, step_timeout_sec: int) -> float | None:
    if not step_timeout_sec:
        return None
    return max(0.0, step_timeout_sec - (time.time() - step_started))


def _wait_captcha_cooldown(
    domain: str,
    retry_num: int,
    wait_min: int,
    total_waited_sec: float,
    step_started: float,
    step_timeout_sec: int,
) -> tuple[float, bool]:
    """
    Interruptible CAPTCHA cooldown with progress logs.
    Returns (updated_total_waited_sec, should_continue).
    """
    wait_sec = wait_min * 60
    budget = _step_budget_remaining(step_started, step_timeout_sec)
    if budget is not None and budget <= 0:
        _log(
            f"CAPTCHA wait retry #{retry_num} for {domain}: "
            f"step timeout reached after {_format_duration(total_waited_sec)} total wait — stopping retries"
        )
        return total_waited_sec, False

    if budget is not None and wait_sec > budget:
        wait_sec = int(budget)
        _log(
            f"CAPTCHA wait retry #{retry_num} for {domain}: "
            f"reducing wait to {_format_duration(wait_sec)} to stay within step timeout"
        )

    _log(
        f"CAPTCHA wait retry #{retry_num} for {domain}: "
        f"starting {_format_duration(wait_sec)} cooldown "
        f"(cumulative waited: {_format_duration(total_waited_sec)}, "
        f"configured wait: {wait_min} min)"
    )
    if budget is not None:
        _log(
            f"CAPTCHA wait retry #{retry_num} for {domain}: "
            f"step budget remaining before wait: {_format_duration(budget)}"
        )

    elapsed_in_wait = 0.0
    tick = 60
    while elapsed_in_wait < wait_sec:
        chunk = min(tick, wait_sec - elapsed_in_wait)
        time.sleep(chunk)
        elapsed_in_wait += chunk
        remaining_in_cycle = wait_sec - elapsed_in_wait
        budget_now = _step_budget_remaining(step_started, step_timeout_sec)
        if remaining_in_cycle > 0:
            budget_msg = (
                f", step budget left: {_format_duration(budget_now)}"
                if budget_now is not None
                else ""
            )
            _log(
                f"CAPTCHA wait retry #{retry_num} for {domain}: "
                f"{_format_duration(elapsed_in_wait)} elapsed this cycle, "
                f"{_format_duration(remaining_in_cycle)} remaining{budget_msg}"
            )

    total_waited_sec += wait_sec
    budget_after = _step_budget_remaining(step_started, step_timeout_sec)
    budget_msg = (
        f", step budget left: {_format_duration(budget_after)}"
        if budget_after is not None
        else ""
    )
    _log(
        f"CAPTCHA wait retry #{retry_num} for {domain}: "
        f"cooldown complete ({_format_duration(wait_sec)} this cycle, "
        f"{_format_duration(total_waited_sec)} cumulative){budget_msg} — resuming Selenium"
    )
    return total_waited_sec, True


def _merge_raw_results(target: list, incoming: list, seen_keys: set) -> None:
    for r in incoming:
        key = (r.get("domain", ""), r.get("url", ""))
        if not key[0] or key in seen_keys:
            continue
        seen_keys.add(key)
        target.append(r)


def run(payload: dict) -> dict:
    domain = payload.get("domain", "")
    words = payload.get("words") or derive_words(domain)
    brand_words = split_domain_words(domain) or words
    max_pages = int(payload.get("max_pages", 3))
    queries = payload.get("search_queries") or build_google_search_queries(domain)
    primary_query = queries[0] if queries else ""

    google_strategy = str(payload.get("google_strategy") or "selenium").strip().lower()
    use_apify_fallback = google_strategy in ("selenium_apify_fallback", "selenium+apify")
    use_wait_retry = google_strategy in ("selenium_wait_retry", "selenium+wait")
    wait_min = int(payload.get("google_wait_min", 10) or 10)
    if wait_min not in (5, 10, 20):
        wait_min = 10
    step_timeout_sec = int(payload.get("step_timeout_sec") or 0)
    step_started = time.time()

    retry_count = 0
    total_wait_sec = 0.0
    wait_retry_stopped = False
    all_raw: list = []
    raw_seen: set = set()

    def run_selenium_pass(context_suffix: str = ""):
        driver = get_driver()
        pass_raw = []
        pass_state = {}
        local_seen: set = set()
        try:
            for qi, query in enumerate(queries):
                for _page, page_results in iter_google_pages(
                    driver,
                    query,
                    max_pages,
                    context=f"google_serp{context_suffix}_q{qi}",
                    state=pass_state,
                ):
                    _merge_raw_results(pass_raw, page_results, local_seen)
        finally:
            release_driver(driver)
        return pass_raw, bool(pass_state.get("captcha_encountered"))

    def absorb_pass(pass_raw: list) -> None:
        _merge_raw_results(all_raw, pass_raw, raw_seen)

    pass_raw, captcha_encountered = run_selenium_pass()
    absorb_pass(pass_raw)
    if captcha_encountered:
        _log(
            f"CAPTCHA detected for {domain} on initial Selenium pass "
            f"({len(queries)} queries, strategy={google_strategy})"
        )

    if use_wait_retry and captcha_encountered:
        _log(
            f"CAPTCHA wait+retry enabled for {domain}: "
            f"{wait_min} min per retry, step timeout budget {_format_duration(step_timeout_sec)}"
        )
        while captcha_encountered:
            retry_count += 1
            total_wait_sec, should_continue = _wait_captcha_cooldown(
                domain,
                retry_count,
                wait_min,
                total_wait_sec,
                step_started,
                step_timeout_sec,
            )
            if not should_continue:
                wait_retry_stopped = True
                _log(
                    f"CAPTCHA wait+retry stopped for {domain} after {retry_count} scheduled retries "
                    f"({_format_duration(total_wait_sec)} total wait)"
                )
                break

            _log(f"CAPTCHA wait+retry #{retry_count} for {domain}: starting Selenium pass")
            pass_raw, captcha_encountered = run_selenium_pass(f"_retry_{retry_count}")
            absorb_pass(pass_raw)
            if not captcha_encountered:
                _log(
                    f"CAPTCHA cleared for {domain} on retry #{retry_count} "
                    f"(total wait: {_format_duration(total_wait_sec)}, retries: {retry_count})"
                )
            else:
                _log(
                    f"CAPTCHA still present for {domain} after retry #{retry_count} "
                    f"— will schedule another wait if step budget allows"
                )

    fallback_used = False
    fallback_error = None

    if captcha_encountered and use_apify_fallback:
        for qi, query in enumerate(queries):
            apify_out = search_google_via_apify(query, max_pages=max_pages)
            if apify_out.get("ok"):
                fallback_used = True
                before = len(all_raw)
                _merge_raw_results(all_raw, apify_out.get("results") or [], raw_seen)
                added = len(all_raw) - before
                _log(
                    f"apify fallback q{qi} for {domain} (added {added} results)"
                )
            elif not fallback_error:
                fallback_error = apify_out.get("error") or "apify fallback failed"
                _log(f"apify fallback q{qi} failed for {domain}: {fallback_error}")

    classified = []
    seen = set()
    for r in all_raw:
        dom = r.get("domain", "")
        if not dom or dom in seen:
            continue
        seen.add(dom)
        mt = classify_google_result(
            brand_words,
            dom,
            r.get("title", ""),
            r.get("snippet", ""),
        )
        if mt == "none":
            mt = classify_other_path_result(
                brand_words,
                r.get("title", ""),
                r.get("snippet", ""),
                r.get("url", ""),
            )
        if mt == "none":
            continue
        classified.append({
            "domain": dom,
            "title": r.get("title"),
            "snippet": r.get("snippet"),
            "url": r.get("url"),
            "match_type": mt,
        })

    return {
        "ok": True,
        "query": primary_query,
        "queries": queries,
        "results": classified,
        "raw_count": len(all_raw),
        "pages_fetched": max_pages,
        "captcha_encountered": captcha_encountered,
        "google_strategy": google_strategy,
        "fallback_used": fallback_used,
        "fallback_error": fallback_error,
        "retry_count": retry_count,
        "total_wait_sec": int(total_wait_sec),
        "wait_min": wait_min,
        "wait_retry_stopped": wait_retry_stopped,
    }
