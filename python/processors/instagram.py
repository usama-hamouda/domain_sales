"""Instagram search via Google site: operator."""
from .chrome import get_driver
from .domain_utils import derive_words, brand_query, split_domain_words, classify_other_path_result
from .site_search import site_google_search


def run(payload: dict) -> dict:
    domain = payload.get("domain", "")
    words = payload.get("words") or derive_words(domain)
    brand_words = split_domain_words(domain) or words
    max_pages = int(payload.get("max_pages", 3))
    query = payload.get("search_query") or brand_query(words, domain)

    driver = get_driver()
    raw = site_google_search(driver, "instagram.com", query, max_pages)

    classified = []
    for r in raw:
        mt = classify_other_path_result(
            brand_words, r.get("title", ""), r.get("snippet", ""), r.get("url", "")
        )
        if mt == "none":
            continue
        classified.append({
            "domain": r.get("domain") or "instagram.com",
            "title": r.get("title"),
            "snippet": r.get("snippet"),
            "url": r.get("url"),
            "match_type": mt,
        })

    return {
        "ok": True,
        "query": f"site:instagram.com {query}",
        "results": classified,
        "raw_count": len(raw),
    }
