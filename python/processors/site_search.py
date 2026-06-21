"""Google site: restricted search helper."""
from .google_nav import iter_google_pages


def site_google_search(driver, site_fragment: str, query: str, max_pages: int) -> list[dict]:
    """Search Google with site: filter and return parsed hits for that site."""
    results = []
    seen = set()
    full_query = f"site:{site_fragment} {query}"

    for _page, page_results in iter_google_pages(
        driver, full_query, max_pages, context=f"site:{site_fragment}"
    ):
        for row in page_results:
            href = row.get("url") or ""
            if site_fragment not in href:
                continue
            if href in seen:
                continue
            seen.add(href)
            results.append(row)

    return results
