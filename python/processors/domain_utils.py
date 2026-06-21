"""Shared utilities for domain word extraction and match classification."""
import re
from urllib.parse import urlparse

SPLIT_SUFFIXES = [
    "tech", "ai", "labs", "lab", "digital", "media", "cloud", "soft", "software",
    "systems", "system", "group", "global", "capital", "finance", "fintech", "pay",
    "store", "shop", "studio", "marketing", "consulting", "logistics", "health",
]

# Alternate TLDs for Method 2 Google prospecting (site:*.<tld> "company name").
GOOGLE_PROSPECT_TLDS = ["net", "org", "io", "au", "ca"]


def split_domain_words(domain: str) -> list[str]:
    """Split domain SLD into meaningful brand words (prefer CamelCase + suffix split)."""
    raw = (domain or "").split(".")[0].strip()
    if not raw:
        return []
    full = raw.lower()
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    parts = [p.lower() for p in re.split(r"[^a-zA-Z0-9]+", spaced) if p and len(p) > 1]

    # If import preserved CamelCase, we already have good tokens.
    if len(parts) >= 2:
        return list(dict.fromkeys(parts))

    # Fallback: split known suffixes for lowercase domains like skywtech.com.
    for suf in SPLIT_SUFFIXES:
        if full.endswith(suf) and len(full) > len(suf) + 2:
            head = full[:-len(suf)]
            return [head, suf]

    return [full]


def derive_words(domain: str) -> list[str]:
    raw = (domain or "").split(".")[0]
    full = raw.lower()
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    raw_parts = [p.lower() for p in re.split(r"[^a-zA-Z0-9]+", spaced) if p]
    heuristic_parts = []
    for suf in SPLIT_SUFFIXES:
        if full.endswith(suf) and len(full) > len(suf) + 2:
            head = full[:-len(suf)]
            heuristic_parts.extend([head, suf])
            break

    arr = list(dict.fromkeys([full] + raw_parts + heuristic_parts))
    has_long = any(len(x) > 3 for x in arr)
    arr = [t for t in arr if len(t) > 2 or not has_long]
    return arr if arr else ([full] if full else [])


def brand_search_query(domain: str) -> str:
    """Build spaced Google query, e.g. AsFinTech.com -> 'asfin tech'."""
    raw = (domain or "").split(".")[0]
    full = raw.lower().strip()
    if not full:
        return ""

    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    parts = [p.lower() for p in re.split(r"[^a-zA-Z0-9]+", spaced) if p and len(p) > 1]

    if len(parts) <= 1:
        for suf in SPLIT_SUFFIXES:
            if full.endswith(suf) and len(full) > len(suf) + 2:
                return f"{full[:-len(suf)]} {suf}"
        return full

    if len(parts) > 2:
        return f"{''.join(parts[:-1])} {parts[-1]}"
    return " ".join(parts)


def company_name_spaced(domain: str) -> str:
    """Spaced company name derived from the domain SLD, e.g. montarygroup.com -> 'montary group'."""
    return brand_search_query(domain)


def company_name_compact(domain: str) -> str:
    """Compact company name without spaces, e.g. montarygroup.com -> 'montarygroup'."""
    raw = (domain or "").split(".")[0]
    return raw.lower().strip() if raw else ""


def build_google_search_queries(domain: str, prospect_tlds: list[str] | None = None) -> list[str]:
    """
    Build the full Google prospecting search queue for a domain.

    Method 1 — spaced company name (existing behavior):
        montarygroup.com -> montary group

    Method 2 — alternate TLD site searches:
        site:*.net "montary group", site:*.org "montary group", ...

    Method 3 — compact name without spaces:
        "montarygroup"

    Returns de-duplicated queries in execution order.
    """
    tlds = prospect_tlds if prospect_tlds is not None else GOOGLE_PROSPECT_TLDS
    spaced = company_name_spaced(domain)
    compact = company_name_compact(domain)

    queries: list[str] = []
    seen: set[str] = set()

    def add(query: str) -> None:
        key = query.strip().lower()
        if query and key not in seen:
            seen.add(key)
            queries.append(query)

    # Method 1: primary spaced-name search (unchanged).
    if spaced:
        add(spaced)

    # Method 2: find prospects on alternate TLDs / ccTLDs.
    if spaced:
        for tld in tlds:
            tld_clean = (tld or "").strip().lstrip(".")
            if tld_clean:
                add(f'site:*.{tld_clean} "{spaced}"')

    # Method 3: compact name — surfaces montarygroup.net, montary-group.com, etc.
    if compact and spaced and " " in spaced:
        add(f'"{compact}"')

    return queries


def brand_query(words: list[str], domain: str = "") -> str:
    if domain:
        return brand_search_query(domain)
    parts = [w for w in words if w and len(w) > 2]
    if len(parts) > 2:
        return f"{''.join(parts[:-1])} {parts[-1]}"
    if len(parts) == 2:
        return f"{parts[0]} {parts[1]}"
    return parts[0] if parts else ""


def words_in_text(words: list[str], text: str) -> str:
    """Return match_type: exact | partial | title | none"""
    if not text:
        return "none"
    t = text.lower()
    full = "".join(words) if words else ""
    if full and full in t:
        return "exact"
    hits = sum(1 for w in words if len(w) > 2 and w in t)
    if hits >= len([w for w in words if len(w) > 2]):
        return "exact"
    if hits > 0:
        return "partial"
    return "none"


def count_word_hits(words: list[str], text: str) -> int:
    if not text:
        return 0
    t = text.lower()
    return sum(1 for w in dict.fromkeys(words) if len(w) > 1 and w in t)


def classify_google_result(brand_words: list[str], result_domain: str, title: str, snippet: str) -> str:
    """Google path rules:
    - 2+ words in result domain => exact
    - 1 word in result domain => partial
    - 2+ words in title and 2+ words in snippet => partial
    - otherwise exclude
    """
    domain_hits = count_word_hits(brand_words, (result_domain or "").replace(".", " "))
    title_hits = count_word_hits(brand_words, title or "")
    snippet_hits = count_word_hits(brand_words, snippet or "")

    if domain_hits >= 2:
        return "exact"
    if domain_hits == 1:
        return "partial"
    if title_hits >= 2 and snippet_hits >= 2:
        return "partial"
    return "none"


def classify_other_path_result(brand_words: list[str], title: str, snippet: str, url: str = "") -> str:
    """Other paths rules:
    - include when 2+ brand words appear in title, snippet, or URL path
    - exclude when only 0/1 word appears
    """
    title_hits = count_word_hits(brand_words, title or "")
    snippet_hits = count_word_hits(brand_words, snippet or "")
    url_text = (url or "").lower().replace("/", " ").replace("-", " ").replace("_", " ").replace(".", " ")
    url_hits = count_word_hits(brand_words, url_text)
    if max(title_hits, snippet_hits, url_hits) >= 2:
        return "partial"
    return "none"


def extract_domain_from_url(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""
