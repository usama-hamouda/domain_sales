import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, log } from 'crawlee';

// ═══════════════════════════════════════════════════════════════════════════════
// ACTOR CONFIGURATION — edit here, not in the input form
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    COST_PER_REQUEST:     0.003,   // Apify SERP proxy = $3 / 1,000 requests
    MAX_COST_USD:         1.0,     // hard SERP spend cap per run (protects profit)
    BASE_PAGES:           10,
    ALPHA_SINGLE_PAGES:   1,
    ALPHA_PAIR_PAGES:     1,
    MAX_CONCURRENCY:      3,
    REQUEST_TIMEOUT_SEC:  60,
    MAX_RETRIES:          2,
    RESULTS_PER_PAGE:     10,

    // ── Payment / monetization ─────────────────────────────────────────────
    // PPE event name — must match exactly what you define in Apify Console
    PPE_EVENT_NAME:       'profile-discovered',

    // Price charged to user per profile: $1.50 per 1,000 = $0.0015 each
    PRICE_PER_PROFILE:    0.0015,

    // Free tier: capped at this many profiles per run, no charge
    FREE_TIER_MAX:        50,
};

// ── Language character maps (inlined from languages.js) ────────────────────────
const LANGUAGE_CHARS = {

    // ── Arabic (AR) — used by: SA, AE, EG ──────────────────────────────────
    AR: {
        single: [
            'ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش',
            'ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي',
        ],
        pairs: [
            'ال','من','في','على','إل','عن','مع','هذ','كل','قد',
            'لم','لن','أن','إن','حت','بعد','قبل','عند','بين','خلا',
        ],
    },

    // ── Hindi / Devanagari (HI) — used by: IN ──────────────────────────────
    HI: {
        single: [
            'अ','आ','इ','ई','उ','ऊ','ए','ऐ','ओ','औ',
            'क','ख','ग','घ','च','छ','ज','झ','ट','ठ',
            'ड','ढ','त','थ','द','ध','न','प','फ','ब',
            'भ','म','य','र','ल','व','श','ष','स','ह',
        ],
        pairs: [
            'का','की','के','में','से','पर','को','और','भी','तो',
            'है','हैं','था','थे','थी','हो','हुआ','कर','जो','या',
        ],
    },

    // ── Chinese Simplified (ZH) — used by: CN ──────────────────────────────
    ZH: {
        single: [
            '的','一','是','在','不','了','有','和','人','这',
            '中','大','为','上','个','国','我','以','要','他',
            '时','来','用','们','生','到','作','地','于','出',
        ],
        pairs: [
            '中国','我的','他们','什么','这个','那个','可以','没有','一个','如果',
            '因为','所以','但是','不是','也是','还有','只有','已经','非常','一样',
        ],
    },

    // ── Russian (RU) ────────────────────────────────────────────────────────
    RU: {
        single: [
            'а','б','в','г','д','е','ё','ж','з','и','й','к','л','м',
            'н','о','п','р','с','т','у','ф','х','ц','ч','ш','щ','э','ю','я',
        ],
        pairs: [
            'ал','ан','ар','ас','ат','ин','ир','ит','ко','ла',
            'ле','ли','ло','лу','ма','ме','ми','мо','на','не',
            'ни','но','ов','ол','ор','ос','от','ра','ре','ри',
        ],
    },

    // ── Japanese (JA) ───────────────────────────────────────────────────────
    JA: {
        single: [
            'あ','い','う','え','お','か','き','く','け','こ',
            'さ','し','す','せ','そ','た','ち','つ','て','と',
            'な','に','ぬ','ね','の','は','ひ','ふ','へ','ほ',
            'ま','み','む','め','も','や','ゆ','よ','ら','り',
            'る','れ','ろ','わ','を','ん',
        ],
        pairs: [
            'ああ','あい','あう','いい','うえ','おお','かか','きき',
            'くく','けけ','ここ','ささ','しし','すす','せせ','そそ',
            'たた','ちち','つつ','てて','とと','なな','にに','ぬぬ',
        ],
    },

    // ── Korean (KO) ─────────────────────────────────────────────────────────
    KO: {
        single: [
            '가','나','다','라','마','바','사','아','자','차',
            '카','타','파','하','기','니','디','리','미','비',
            '시','이','지','치','키','티','피','히','고','노',
        ],
        pairs: [
            '가나','가다','나다','나라','다라','라마','마바','바사','사아','아자',
            '자차','차카','카타','타파','파하','기니','니디','디리','리미','미비',
        ],
    },

    // ── Thai (TH) ───────────────────────────────────────────────────────────
    TH: {
        single: [
            'ก','ข','ค','ง','จ','ช','ซ','ญ','ด','ต',
            'ถ','ท','น','บ','ป','ผ','ฝ','พ','ฟ','ภ',
            'ม','ย','ร','ล','ว','ส','ห','อ','ฮ',
        ],
        pairs: [
            'กา','กี','กู','เก','โก','ขา','ขี','ขู','คา','คี',
            'งา','งี','จา','จี','ชา','ชี','ดา','ดี','ตา','ตี',
        ],
    },

    // ── Vietnamese (VI) ─────────────────────────────────────────────────────
    VI: {
        single: [
            'a','ă','â','b','c','d','đ','e','ê','g',
            'h','i','k','l','m','n','o','ô','ơ','p',
            'q','r','s','t','u','ư','v','x','y',
        ],
        pairs: [
            'an','ao','au','ba','bà','bá','bi','bị','bổ','ca',
            'cá','cả','ci','co','có','cô','da','đã','đi','em',
            'en','gi','hà','hé','hi','hô','ia','in','là','le',
        ],
    },

    // ── Persian / Farsi (FA) — used by: IR ──────────────────────────────────
    FA: {
        single: [
            'ا','ب','پ','ت','ث','ج','چ','ح','خ','د',
            'ذ','ر','ز','ژ','س','ش','ص','ض','ط','ظ',
            'ع','غ','ف','ق','ک','گ','ل','م','ن','و','ه','ی',
        ],
        pairs: [
            'از','با','به','بر','تا','در','را','که','می','این',
            'آن','هم','یا','ما','او','هر','اگر','پس','هیچ','چون',
        ],
    },

    // ── Bengali (BN) — used by: BD ──────────────────────────────────────────
    BN: {
        single: [
            'অ','আ','ই','ঈ','উ','ঊ','এ','ঐ','ও','ঔ',
            'ক','খ','গ','ঘ','চ','ছ','জ','ঝ','ট','ঠ',
            'ড','ঢ','ত','থ','দ','ধ','ন','প','ফ','ব',
            'ভ','ম','য','র','ল','শ','ষ','স','হ',
        ],
        pairs: [
            'এক','দুই','তিন','চার','পাঁচ','ছয়','সাত','আট','নয়','দশ',
            'আমি','তুমি','সে','আমরা','তোমরা','তারা','কি','কেন','কোথায়','কখন',
        ],
    },

    // ── Turkish (TR) ────────────────────────────────────────────────────────
    // Latin-based but with extra chars; supplement standard a-z with Turkish specifics
    TR: {
        single: [
            'a','b','c','ç','d','e','f','g','ğ','h','ı','i','j','k','l',
            'm','n','o','ö','p','r','s','ş','t','u','ü','v','y','z',
        ],
        pairs: [
            'bu','da','de','bir','ben','sen','biz','siz','ile','için',
            'ama','ya','ve','en','çok','her','kim','ne','bu','şu',
        ],
    },

    // ── Indonesian / Malay (ID) ──────────────────────────────────────────────
    // Standard Latin — no special chars needed, uses main a-z alphabet
    // (defined here as empty so the code falls back to Latin pairs from main.js)
    ID: null,

    // Latin-script countries — null = use standard a-z from main.js
    // DE, FR, IT, ES, PT, NL, PL, RO, CZ, SK, HU, HR, SL, SR, BG, MK
};

/**
 * Return the character sets to use for a given language code.
 * Falls back to null (caller should use standard Latin a-z).
 */
function getLanguageChars(langCode) {
    if (!langCode) return null;
    const key = langCode.split('-')[0].toUpperCase(); // 'zh-CN' → 'ZH'
    return LANGUAGE_CHARS[key] ?? null;
}


// ── Country definitions ───────────────────────────────────────────────────────
const COUNTRIES = {
    US: { code:'US', name:'United States',  googleDomain:'google.com',    proxyCountry:'US', lang:'en'    },
    IN: { code:'IN', name:'India',           googleDomain:'google.co.in',  proxyCountry:'IN', lang:'hi'    },
    CN: { code:'CN', name:'China',           googleDomain:'google.com',    proxyCountry:'CN', lang:'zh-CN' },
    BR: { code:'BR', name:'Brazil',          googleDomain:'google.com.br', proxyCountry:'BR', lang:'pt-BR' },
    ID: { code:'ID', name:'Indonesia',       googleDomain:'google.co.id',  proxyCountry:'ID', lang:'id'    },
    PK: { code:'PK', name:'Pakistan',        googleDomain:'google.com.pk', proxyCountry:'PK', lang:'ur'    },
    NG: { code:'NG', name:'Nigeria',         googleDomain:'google.com.ng', proxyCountry:'NG', lang:'en'    },
    BD: { code:'BD', name:'Bangladesh',      googleDomain:'google.com.bd', proxyCountry:'BD', lang:'bn'    },
    RU: { code:'RU', name:'Russia',          googleDomain:'google.ru',     proxyCountry:'RU', lang:'ru'    },
    MX: { code:'MX', name:'Mexico',          googleDomain:'google.com.mx', proxyCountry:'MX', lang:'es'    },
    ET: { code:'ET', name:'Ethiopia',        googleDomain:'google.com.et', proxyCountry:'ET', lang:'en'    },
    JP: { code:'JP', name:'Japan',           googleDomain:'google.co.jp',  proxyCountry:'JP', lang:'ja'    },
    PH: { code:'PH', name:'Philippines',     googleDomain:'google.com.ph', proxyCountry:'PH', lang:'en'    },
    EG: { code:'EG', name:'Egypt',           googleDomain:'google.com.eg', proxyCountry:'EG', lang:'ar'    },
    VN: { code:'VN', name:'Vietnam',         googleDomain:'google.com.vn', proxyCountry:'VN', lang:'vi'    },
    TR: { code:'TR', name:'Turkey',          googleDomain:'google.com.tr', proxyCountry:'TR', lang:'tr'    },
    IR: { code:'IR', name:'Iran',            googleDomain:'google.com',    proxyCountry:'IR', lang:'fa'    },
    DE: { code:'DE', name:'Germany',         googleDomain:'google.de',     proxyCountry:'DE', lang:'de'    },
    TH: { code:'TH', name:'Thailand',        googleDomain:'google.co.th',  proxyCountry:'TH', lang:'th'    },
    GB: { code:'GB', name:'United Kingdom',  googleDomain:'google.co.uk',  proxyCountry:'GB', lang:'en'    },
    FR: { code:'FR', name:'France',          googleDomain:'google.fr',     proxyCountry:'FR', lang:'fr'    },
    IT: { code:'IT', name:'Italy',           googleDomain:'google.it',     proxyCountry:'IT', lang:'it'    },
    CA: { code:'CA', name:'Canada',          googleDomain:'google.ca',     proxyCountry:'CA', lang:'en'    },
    KR: { code:'KR', name:'South Korea',     googleDomain:'google.co.kr',  proxyCountry:'KR', lang:'ko'    },
    AU: { code:'AU', name:'Australia',       googleDomain:'google.com.au', proxyCountry:'AU', lang:'en'    },
    ES: { code:'ES', name:'Spain',           googleDomain:'google.es',     proxyCountry:'ES', lang:'es'    },
    SA: { code:'SA', name:'Saudi Arabia',    googleDomain:'google.com.sa', proxyCountry:'SA', lang:'ar'    },
    AE: { code:'AE', name:'UAE',             googleDomain:'google.ae',     proxyCountry:'AE', lang:'ar'    },
    NL: { code:'NL', name:'Netherlands',     googleDomain:'google.nl',     proxyCountry:'NL', lang:'nl'    },
};

// Latin a-z (fallback for countries with no native-script map)
const LATIN_CHARS = 'abcdefghijklmnopqrstuvwxyz'.split('');

// US states — used for US country geographic sub-targeting
const US_STATES = [
    'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
    'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
    'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
    'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada',
    'New Hampshire','New Jersey','New Mexico','New York','North Carolina',
    'North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island',
    'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont',
    'Virginia','Washington','West Virginia','Wisconsin','Wyoming',
];

// Non-Latin languages that have a native alphabet map in languages.js
const NON_LATIN_LANGS = new Set(['ar','hi','zh','zh-CN','ja','ko','th','vi','fa','bn','ru','tr']);

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

const EXCLUSIONS = '-site:instagram.com/p/ -site:instagram.com/popular/ -site:instagram.com/reel/';

function buildQuery(keyword, countryCode = '', modifier = '') {
    const parts = [`site:instagram.com "${keyword}"`];
    if (countryCode) parts.push(countryCode);
    if (modifier)    parts.push(modifier);
    parts.push(EXCLUSIONS);
    return parts.join(' ');
}

function reverseKeyword(kw) {
    return kw.trim().split(/\s+/).reverse().join(' ');
}

function buildSearchUrl({ queryStr, googleDomain, lang, page = 0 }) {
    const q     = encodeURIComponent(queryStr);
    const hl    = encodeURIComponent(lang || 'en');
    const start = page * CONFIG.RESULTS_PER_PAGE;
    let url = `http://www.${googleDomain}/search?q=${q}&hl=${hl}`;
    if (start > 0) url += `&start=${start}`;
    return url;
}

function generateLatinPairs() {
    const pairs = [];
    for (let gap = 1; gap < LATIN_CHARS.length; gap++) {
        for (let i = 0; i + gap < LATIN_CHARS.length; i++) {
            pairs.push(LATIN_CHARS[i] + LATIN_CHARS[i + gap]);
            pairs.push(LATIN_CHARS[i + gap] + LATIN_CHARS[i]);
        }
    }
    return pairs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY PLAN BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildQueryPlan({ keyword, country }) {
    const plan = [];
    const { code: cc, name: countryName, googleDomain, lang } = country;
    const reversed = reverseKeyword(keyword);

    const langChars  = getLanguageChars(lang);
    const isNonLatin = NON_LATIN_LANGS.has(lang.toLowerCase());
    const nativeSingles = (isNonLatin && langChars) ? langChars.single : [];
    const nativePairs   = (isNonLatin && langChars) ? langChars.pairs  : [];
    const latinPairs    = generateLatinPairs();

    if (nativeSingles.length > 0) {
        log.debug(`[LANG] "${cc}" native chars: ${nativeSingles.length} singles, ${nativePairs.length} pairs`);
    }

    // Helper to push N pages for a given modifier and pattern name
    const push = (queryStr, patternName, variantLabel, pages) => {
        for (let page = 0; page < pages; page++) {
            plan.push({ queryStr, patternName, variantLabel, googleDomain, lang, page });
        }
    };

    // ── Stage 1: base query ──
    for (let page = 0; page < CONFIG.BASE_PAGES; page++) {
        plan.push({ queryStr: buildQuery(keyword, cc), patternName: 'base',
            variantLabel: `[${countryName}] ${keyword}`, googleDomain, lang, page });
    }

    // ── Stage 2: reversed keyword ──
    if (reversed !== keyword) {
        for (let page = 0; page < CONFIG.BASE_PAGES; page++) {
            plan.push({ queryStr: buildQuery(reversed, cc), patternName: 'reversed',
                variantLabel: `[${countryName}] ${reversed}`, googleDomain, lang, page });
        }
    }

    // ── Stage 3: US states (US only, alongside letters below) ──
    if (cc === 'US') {
        for (const state of US_STATES) {
            push(buildQuery(keyword, cc, state), 'usState',
                `[${countryName}] ${keyword} ${state}`, CONFIG.ALPHA_SINGLE_PAGES);
        }
    }

    // ── Stage 4: native language single chars (kw + lang single, one by one) ──
    for (const char of nativeSingles) {
        push(buildQuery(keyword, cc, char), 'nativeSingle',
            `[${countryName}] ${keyword} ${char}`, CONFIG.ALPHA_SINGLE_PAGES);
    }

    // ── Stage 5: Latin single chars a-z ──
    for (const char of LATIN_CHARS) {
        push(buildQuery(keyword, cc, char), 'latinSingle',
            `[${countryName}] ${keyword} ${char}`, CONFIG.ALPHA_SINGLE_PAGES);
    }

    // ── Stage 6: Latin pairs ab, ba, ac, ca… ──
    for (const pair of latinPairs) {
        // Each char of the pair is space-separated so Google treats them as loose terms
        // e.g. "travel blogger" a b  not  "travel blogger" ab
        const mod = pair.split('').join(' ');
        push(buildQuery(keyword, cc, mod), 'latinPair',
            `[${countryName}] ${keyword} ${mod}`, CONFIG.ALPHA_PAIR_PAGES);
    }

    // ── Stage 7: native language pairs (space-separated chars) ──
    for (const pair of nativePairs) {
        // Split into individual chars and join with space
        const chars = [...pair]; // handles multi-byte correctly
        const mod   = chars.join(' ');
        push(buildQuery(keyword, cc, mod), 'nativePair',
            `[${countryName}] ${keyword} ${mod}`, CONFIG.ALPHA_PAIR_PAGES);
    }

    return plan;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

const INSTAGRAM_SKIP_PATHS = new Set([
    'p','reel','reels','stories','explore','tv','accounts','direct','about',
    'legal','privacy','terms','help','press','shop','highlights','challenge',
    'ar','developer','studio','download','blog','creators','nametag',
    'directory','lite','web','api','graphql',
]);

function extractInstagramProfile(href) {
    if (!href || !href.includes('instagram.com')) return null;
    let url = href;
    try { url = decodeURIComponent(href); } catch (_) {}
    if (url.startsWith('/url?') || url.includes('google.com/url?')) {
        try {
            const base = url.startsWith('/url?') ? `http://x${url}` : url;
            const q = new URL(base).searchParams.get('q');
            if (q) url = q;
        } catch (_) {}
    }
    const match = url.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})/);
    if (!match) return null;
    const username = match[1];
    if (INSTAGRAM_SKIP_PATHS.has(username.toLowerCase())) return null;
    if (username.length < 2) return null;
    if (/^[_.]/.test(username) || /[_.]$/.test(username)) return null;
    return { username, profileUrl: `https://www.instagram.com/${username}/` };
}

function parseGoogleResults($) {
    const results = [];
    const seen    = new Set();
    let totalLinks = 0, instagramLinks = 0, skippedReserved = 0, skippedDupe = 0;

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        totalLinks++;
        if (!href.includes('instagram.com')) return;
        instagramLinks++;
        const profile = extractInstagramProfile(href);
        if (!profile) { skippedReserved++; return; }
        if (seen.has(profile.profileUrl)) { skippedDupe++; return; }
        seen.add(profile.profileUrl);

        // ── Snippet extraction ──
        // Google SERP structure (as of 2024-2025):
        //   <div class="g">                     ← result block
        //     <a href="...">title</a>
        //     <div class="VwiC3b ...">           ← snippet container (class varies)
        //       <span>...</span>                 ← date (optional)
        //       <span>bio text here</span>       ← actual snippet text
        //     </div>
        //   </div>
        //
        // Strategy:
        //   1. From the link, climb up until we find a container that has
        //      text NOT inside any <a> tag (i.e. not a link label).
        //   2. Collect leaf text nodes (deepest spans with no child elements)
        //      to avoid picking up parent spans that concatenate child text.
        //   3. De-duplicate repeated phrases (Google sometimes repeats the
        //      title or domain in multiple sibling spans).
        //   4. Prefer longer unique text segments.

        let snippet = '';
        try {
            let $container = $(el);

            // Climb up max 10 levels to find the result block
            for (let i = 0; i < 10; i++) {
                $container = $container.parent();
                const tagName = $container.prop('tagName')?.toLowerCase();
                // Stop at known result container markers
                if (tagName === 'body' || tagName === 'html') break;

                // Collect leaf-level text nodes: spans/divs that have no
                // element children (pure text containers)
                const leafTexts = [];
                $container.find('span, div').each((_, node) => {
                    const $n = $(node);
                    // Skip if inside an <a> tag (those are title/URL labels)
                    if ($n.closest('a').length > 0) return;
                    // Only take leaf nodes (no element children)
                    if ($n.children('span, div, a, b, em, strong').length > 0) return;
                    const t = $n.text().trim();
                    if (t.length < 5) return;
                    // Skip URL-like strings and instagram.com domain text
                    if (t.includes('instagram.com') || t.startsWith('http')) return;
                    // Skip pure numbers or follower-count-only strings (keep mixed ones)
                    if (/^[\d.,]+[KkMm]?\+?\s*(followers?|following|posts?)?$/i.test(t)) {
                        leafTexts.push(t); // keep follower counts but tag them
                        return;
                    }
                    leafTexts.push(t);
                });

                if (leafTexts.length === 0) continue;

                // De-duplicate: remove exact repeats and texts fully contained in another
                const unique = [];
                for (const t of leafTexts) {
                    if (!unique.some(u => u === t || u.includes(t) || t.includes(u))) {
                        unique.push(t);
                    }
                }

                // Prefer non-follower-count texts first, then append counts
                const bioTexts      = unique.filter(t => !/^[\d.,]+[KkMm]?\+?/.test(t));
                const countTexts    = unique.filter(t => /^[\d.,]+[KkMm]?\+?/.test(t));
                const ordered       = [...bioTexts, ...countTexts];

                const candidate = ordered.join(' · ').trim();
                if (candidate.length >= 15) {
                    snippet = candidate.slice(0, 300);
                    break;
                }
            }
        } catch (_) {}

        results.push({ ...profile, snippet });
    });

    return { results, stats: { totalLinks, instagramLinks, skippedReserved, skippedDupe } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COST TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

class CostTracker {
    constructor() { this.totalRequests = 0; }
    record() { this.totalRequests++; }
    get cost() { return this.totalRequests * CONFIG.COST_PER_REQUEST; }
    get capReached() { return this.cost >= CONFIG.MAX_COST_USD; }
    get remaining() { return Math.max(0, Math.floor((CONFIG.MAX_COST_USD - this.cost) / CONFIG.COST_PER_REQUEST)); }
    summary() { return `req=${this.totalRequests} cost=$${this.cost.toFixed(4)}/$${CONFIG.MAX_COST_USD} rem=${this.remaining}`; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class QueueManager {
    constructor({ planKeys, plans, requestQueue, maxProfilesPerKeyword }) {
        this.requestQueue          = requestQueue;
        this.maxProfilesPerKeyword = maxProfilesPerKeyword;
        this.cursors = Object.fromEntries(planKeys.map(k => [k, 0]));
        this.plans   = plans;
    }

    async enqueueInitial() {
        for (const key of Object.keys(this.plans)) await this._enqueueAt(key, 0);
    }

    async enqueueNextIfNeeded(planKey, profilesCollected, rawCount, currentVariantLabel, effectiveMax) {
        const limit = effectiveMax ?? this.maxProfilesPerKeyword;
        if (profilesCollected >= limit) {
            log.debug(`[QUEUE:done] "${planKey}" — target reached.`);
            return;
        }
        const plan = this.plans[planKey];
        const cur  = this.cursors[planKey];

        if (rawCount === 0) {
            let next = cur + 1, skipped = 0;
            while (next < plan.length && plan[next].variantLabel === currentVariantLabel) { next++; skipped++; }
            if (skipped) log.debug(`[QUEUE:skip] "${planKey}" zero results — skipped ${skipped} pages of "${currentVariantLabel}"`);
            if (next >= plan.length) { log.debug(`[QUEUE:exhausted] "${planKey}"`); return; }
            await this._enqueueAt(planKey, next);
            return;
        }
        const next = cur + 1;
        if (next >= plan.length) { log.debug(`[QUEUE:exhausted] "${planKey}" — all ${plan.length} steps used.`); return; }
        await this._enqueueAt(planKey, next);
    }

    async _enqueueAt(planKey, idx) {
        const plan = this.plans[planKey];
        if (idx >= plan.length) return;
        this.cursors[planKey] = idx;
        const step = plan[idx];
        const url  = buildSearchUrl({ queryStr: step.queryStr, googleDomain: step.googleDomain, lang: step.lang, page: step.page });
        await this.requestQueue.addRequest({
            url,
            userData: { planKey, ...step, planIdx: idx, planTotal: plan.length },
            uniqueKey: url,
        });
        log.debug(`[QUEUE:enqueue] "${planKey}" step ${idx+1}/${plan.length} | ${step.patternName} | "${step.variantLabel}" p${step.page+1}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE TIP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const LANG_TIP = `
╔══════════════════════════════════════════════════════════════════════╗
║  💡 TIP — FOR BEST RESULTS USE THE TARGET COUNTRY'S LANGUAGE        ║
║                                                                      ║
║  This actor appends native characters from the target country's     ║
║  language to your keyword to surface locally-indexed profiles        ║
║  that would never appear in English searches.                        ║
║                                                                      ║
║  ✅ Instead of:  "travel blogger"  (for Arabic countries)           ║
║     Use:         "مدون سياحي"                                        ║
║                                                                      ║
║  ✅ Instead of:  "fitness coach"   (for Japanese)                   ║
║     Use:         "フィットネスコーチ"                                  ║
║                                                                      ║
║  ✅ Instead of:  "photographer"    (for Russian)                    ║
║     Use:         "фотограф"                                          ║
║                                                                      ║
║  English keywords still work but will find English-bio profiles     ║
║  only — far fewer results for non-English-speaking countries.       ║
╚══════════════════════════════════════════════════════════════════════╝
`.trim();

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

await Actor.init();

const input = await Actor.getInput();

const {
    keywords             = [],
    maxProfilesPerKeyword = 100,
    countries            = ['US'],
} = input || {};

if (!keywords.length) throw new Error('"keywords" must be a non-empty array.');

const resolvedCountries = countries.map(cc => {
    const c = COUNTRIES[cc.toUpperCase()];
    if (!c) throw new Error(`Unknown country code "${cc}". Supported: ${Object.keys(COUNTRIES).join(', ')}`);
    return c;
});

// ── Payment setup ──────────────────────────────────────────────────────────
// Detect whether this run is PPE (paid) or free-tier.
// getPricingInfo().isPayPerEvent is true when the actor is configured for PPE
// in Apify Console AND the user is on a paid plan.
const chargingManager = Actor.getChargingManager();
const isPPE = chargingManager.getPricingInfo().isPayPerEvent;

// Free-tier cap: enforce 50 profiles max per run, no charge applied
// PPE users: charge $0.0015 per profile via Actor.charge() on each push,
//            SDK auto-stops charging at the user's configured max-cost-per-run
const effectiveMaxPerKeyword = isPPE
    ? maxProfilesPerKeyword
    : Math.min(maxProfilesPerKeyword, CONFIG.FREE_TIER_MAX);

if (!isPPE && maxProfilesPerKeyword > CONFIG.FREE_TIER_MAX) {
    log.info(`ℹ️ Free tier: results capped at ${CONFIG.FREE_TIER_MAX} profiles per run. Upgrade to get up to ${maxProfilesPerKeyword}.`);
}

log.debug(`[PAYMENT] isPPE=${isPPE} effectiveMax=${effectiveMaxPerKeyword} pricePerProfile=$${CONFIG.PRICE_PER_PROFILE}`);

// ── Language tip — shown in logs at start ──
log.debug(LANG_TIP);

// Check if any selected country uses a non-Latin language
const nonLatinCountries = resolvedCountries.filter(c => NON_LATIN_LANGS.has(c.lang.toLowerCase()));
if (nonLatinCountries.length > 0) {
    const tip = nonLatinCountries.map(c => `${c.code} (${c.lang})`).join(', ');
    await Actor.setStatusMessage(`⚠️ TIP: For ${tip} — enter keywords in the local language for best results`);
} else {
    await Actor.setStatusMessage('🔍 Starting — building query plans…');
}

log.debug('=== Instagram Profiles Discover — Starting ===', {
    keywords,
    maxProfilesPerKeyword,
    countries: resolvedCountries.map(c => `${c.code} (${c.name}) lang=${c.lang}`),
    config: CONFIG,
});

// ── Build plans ──
const plans    = {};
const planKeys = [];
for (const kw of keywords) {
    for (const country of resolvedCountries) {
        const key = `${kw}::${country.code}`;
        plans[key] = buildQueryPlan({ keyword: kw, country });
        planKeys.push(key);
        log.debug(`[PLAN] "${key}": ${plans[key].length} steps`);
    }
}

// ── State ──
const globalSeenUrls  = new Set();
const perPlanCounts   = Object.fromEntries(planKeys.map(k => [k, 0]));
const perPatternStats = {};
const costTracker     = new CostTracker();
let capReached        = false;
let totalPushed       = 0;

// ── Proxy ──
const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['GOOGLE_SERP'] });
log.debug('[PROXY] GOOGLE_SERP proxy created');

// ── Queue ──
const runId = (Actor.getEnv().actorRunId ?? `local-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
const requestQueue = await RequestQueue.open(`rq-${runId}`);
log.debug('[QUEUE] Fresh queue opened', { name: `rq-${runId}` });

const queueManager = new QueueManager({ planKeys, plans, requestQueue, maxProfilesPerKeyword: effectiveMaxPerKeyword });
await queueManager.enqueueInitial();
const qi = await requestQueue.getInfo();
log.debug(`[QUEUE] ✅ Seeded: ${qi.totalRequestCount} requests (1 per keyword×country — rest on-demand)`);

await Actor.setStatusMessage(`🔍 Crawling — 0 profiles found so far…`);

// ── Crawler ──
const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestQueue,
    maxConcurrency:           CONFIG.MAX_CONCURRENCY,
    maxRequestRetries:        CONFIG.MAX_RETRIES,
    requestHandlerTimeoutSecs: CONFIG.REQUEST_TIMEOUT_SEC,

    async requestHandler({ request, $ }) {
        const { planKey, keyword, patternName, variantLabel, page, planIdx, planTotal, lang } = request.userData;

        if (capReached) { log.debug(`[SKIP:cap] ${variantLabel} p${page+1}`); return; }

        costTracker.record();
        if (!perPatternStats[patternName]) perPatternStats[patternName] = { requests:0, profilesFound:0 };
        perPatternStats[patternName].requests++;

        log.debug(`[SERP:req] #${costTracker.totalRequests} | "${variantLabel}" p${page+1} | ${patternName} step=${planIdx+1}/${planTotal} | ${costTracker.summary()}`);

        const { results: rawResults, stats } = parseGoogleResults($);

        log.debug(`[SERP:response] "${variantLabel}" p${page+1}`, {
            totalLinks: stats.totalLinks, instagramLinks: stats.instagramLinks,
            profilesExtracted: rawResults.length, skippedReserved: stats.skippedReserved,
            skippedDupe: stats.skippedDupe, usernames: rawResults.map(r=>r.username),
        });

        if (rawResults.length === 0) {
            log.debug(`[SERP:empty] "${variantLabel}" p${page+1}`, {
                title: $('title').text().trim(), bodySample: $('body').text().trim().slice(0,200),
            });
        }

        const toSave = [];
        const dupes  = [];

        for (const result of rawResults) {
            if (perPlanCounts[planKey] >= effectiveMaxPerKeyword) break;
            if (globalSeenUrls.has(result.profileUrl)) { dupes.push(result.username); continue; }
            globalSeenUrls.add(result.profileUrl);
            perPlanCounts[planKey]++;
            totalPushed++;
            perPatternStats[patternName].profilesFound++;
            toSave.push({
                profileUrl:   result.profileUrl,
                username:     result.username,
                snippet:      result.snippet || '',
                keyword,
                discoveredAt: new Date().toISOString(),
            });
        }

        log.debug(`[SERP:pushed] "${variantLabel}" p${page+1}: +${toSave.length} new | ${dupes.length} dupes | plan total=${perPlanCounts[planKey]}/${effectiveMaxPerKeyword}`);

        if (toSave.length > 0) {
            if (isPPE) {
                // PPE mode: charge per profile then push.
                // Actor.charge() returns eventChargeLimitReached=true when the user's
                // configured max-cost-per-run is exhausted — stop crawling immediately.
                const chargeResult = await Actor.charge({
                    eventName: CONFIG.PPE_EVENT_NAME,
                    count: toSave.length,
                });
                await Actor.pushData(toSave);

                if (chargeResult.eventChargeLimitReached) {
                    log.info(`✅ Charge limit reached — ${totalPushed} profiles delivered.`);
                    await Actor.setStatusMessage(`✅ ${totalPushed} profiles found — charge limit reached.`);
                    capReached = true;
                    crawler.autoscaledPool?.abort();
                    return;
                }
            } else {
                // Free tier: plain push, no charge
                await Actor.pushData(toSave);

                if (totalPushed >= CONFIG.FREE_TIER_MAX) {
                    log.info(`ℹ️ Free tier limit of ${CONFIG.FREE_TIER_MAX} profiles reached. Upgrade for more.`);
                    await Actor.setStatusMessage(`ℹ️ Free tier: ${CONFIG.FREE_TIER_MAX} profiles found. Upgrade to get more.`);
                    capReached = true;
                    crawler.autoscaledPool?.abort();
                    return;
                }
            }

            await Actor.setStatusMessage(`🔍 ${totalPushed} profiles found`);
            log.info(`🔍 ${totalPushed} profiles found`);
        }

        // SERP cost cap (protects actor profitability regardless of PPE mode)
        if (costTracker.capReached) {
            log.debug(`[BUDGET:cap] SERP cost cap $${CONFIG.MAX_COST_USD} reached.`);
            capReached = true;
            crawler.autoscaledPool?.abort();
            return;
        }
        if (!capReached) {
            await queueManager.enqueueNextIfNeeded(planKey, perPlanCounts[planKey], rawResults.length, variantLabel, effectiveMaxPerKeyword);
        }
    },

    failedRequestHandler({ request, error }) {
        log.debug(`[FAIL] ${request.userData?.variantLabel} p${request.userData?.page+1}: ${error.message}`);
    },
});

await crawler.run();
log.debug('[CRAWLER] Finished.');

// ── Final summary ──
const totalProfiles = Object.values(perPlanCounts).reduce((a,b)=>a+b, 0);
const stats = {
    totalUniqueProfiles: totalProfiles,
    profilesPerPlan:     perPlanCounts,
    totalSerpRequests:   costTracker.totalRequests,
    estimatedCostUsd:    parseFloat(costTracker.cost.toFixed(4)),
    costCapReached:      capReached,
    costPerProfile:      totalProfiles > 0 ? parseFloat((costTracker.cost/totalProfiles).toFixed(5)) : null,
    patternEfficiency:   perPatternStats,
};

// ── Final status message (visible on run page after completion) ──
const finalMsg = capReached
    ? `✅ Done — ${totalProfiles} profiles | ⛔ Cost cap $${CONFIG.MAX_COST_USD} reached | $${costTracker.cost.toFixed(4)} spent`
    : `✅ Done — ${totalProfiles} profiles found | $${costTracker.cost.toFixed(4)} spent`;

await Actor.setStatusMessage(finalMsg, { terminal: true });

// ── End log with tip repeated ──
log.info(`✅ Completed — ${totalProfiles} profiles found | $${costTracker.cost.toFixed(4)} spent`);
log.debug(LANG_TIP);

await Actor.setValue('RUN_STATS', stats);
await Actor.exit();