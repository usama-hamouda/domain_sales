// ExpiredDomains HTML parser (from domains-tools.html)
function tdByClass(tds, cls) {
  return tds.find((td) => td.classList && td.classList.contains(cls)) || null;
}

function getNumFromTd(td) {
  if (!td) return "-";
  let v = (td.querySelector("a")?.innerText || td.innerText || "").trim().replace(/,/g, "").toUpperCase();
  if (!v) return "-";
  let mul = 1;
  if (v.endsWith("K")) { mul = 1e3; v = v.slice(0, -1); }
  else if (v.endsWith("M")) { mul = 1e6; v = v.slice(0, -1); }
  else if (v.endsWith("B")) { mul = 1e9; v = v.slice(0, -1); }
  const n = parseFloat(v);
  return isNaN(n) ? "-" : n * mul;
}

function getTextFromTd(td) {
  if (!td) return null;
  return (td.innerText || "").trim() || null;
}

function extractAllRegisteredTLDs(tds) {
  const cell = tds.find((td) => td.classList && [...td.classList].some((c) => c.startsWith("field_status")));
  if (!cell) return { count: "-", tlds: [] };
  const anchors = cell.querySelectorAll("a");
  const tlds = [...anchors].map((a) => a.textContent.trim().toLowerCase()).filter(Boolean);
  return { count: tlds.length || "-", tlds };
}

function extractTLDStripSmart(tds) {
  const strip = [];
  for (const td of tds) {
    const a = td.querySelector("a.field_statuscom, a[class*='field_status']");
    if (a) strip.push(a.textContent.trim().toLowerCase());
  }
  return strip;
}

function parseExpiredDomainsHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const rows = doc.querySelectorAll("table.base1 tbody tr");
  const results = [];
  rows.forEach((tr) => {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 10) return;
    let domain = "-";
    const link = tds[0].querySelector("a.namelinks");
    if (link) domain = link.textContent.trim();

    const getNum = (td) => {
      if (!td) return "-";
      let v = (td.querySelector("a")?.innerText || td.innerText || "").trim().replace(/,/g, "").toUpperCase();
      if (!v) return "-";
      let mul = 1;
      if (v.endsWith("K")) { mul = 1e3; v = v.slice(0, -1); }
      else if (v.endsWith("M")) { mul = 1e6; v = v.slice(0, -1); }
      else if (v.endsWith("B")) { mul = 1e9; v = v.slice(0, -1); }
      const n = parseFloat(v);
      return isNaN(n) ? "-" : n * mul;
    };

    const tdsArr = Array.from(tds);
    const { count: regCount, tlds: registeredTLDs } = extractAllRegisteredTLDs(tdsArr);
    const tldStrip = extractTLDStripSmart(tdsArr);
    const tdCreation = tdByClass(tdsArr, "field_creationdate");
    const tdAbirth = tdByClass(tdsArr, "field_abirth");
    const tdAentries = tdByClass(tdsArr, "field_aentries");
    const tdMmgr = tdByClass(tdsArr, "field_majestic_globalrank");
    const tdDmoz = tdByClass(tdsArr, "field_dmoz");
    const tdAdd = tdByClass(tdsArr, "field_adddate");
    const tdRdt = tdByClass(tdsArr, "field_related_cnobi");
    const tdWpl = tdByClass(tdsArr, "field_wikipedia_links");
    const tdSg = tdByClass(tdsArr, "field_searchesglobal");
    const tdComp = tdByClass(tdsArr, "field_competition");
    const tdCpc = tdByClass(tdsArr, "field_acpc");
    const tdDp = tdByClass(tdsArr, "field_domainpop");
    const hasClassLayout = !!(tdCreation || tdAbirth);

    results.push({
      domain,
      length: domain.split(".")[0].length,
      backlinks: getNum(tds[4]),
      archive: hasClassLayout ? getNumFromTd(tdCreation) : getNum(tds[6]),
      whois: hasClassLayout ? getNumFromTd(tdAbirth) : getNum(tds[7]),
      regCount,
      registeredTLDs,
      related: tdRdt ? getNumFromTd(tdRdt) : getNum(tds[19]),
      tldState: tldStrip,
      acr: tdAentries ? getNumFromTd(tdAentries) : null,
      mmgr: tdMmgr ? getNumFromTd(tdMmgr) : null,
      dmoz: tdDmoz ? getTextFromTd(tdDmoz) : null,
      addDate: tdAdd ? getTextFromTd(tdAdd) : null,
      wpl: tdWpl ? getNumFromTd(tdWpl) : null,
      sg: tdSg ? getNumFromTd(tdSg) : null,
      comp: tdComp ? getNumFromTd(tdComp) : null,
      cpc: tdCpc ? getNumFromTd(tdCpc) : null,
      dp: tdDp ? getNumFromTd(tdDp) : null,
    });
  });
  return results;
}

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "," && !inQuote) { result.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  result.push(cur.trim());
  return result;
}

function looksLikeDomain(s) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(String(s || "").trim());
}

/** ExpiredDomains / spreadsheet export without a header row */
const HEADERLESS_COLUMNS = [
  "domain", "length", "backlinks", "archive", "whois", "regcount",
  "mmgr", "dmoz", "related", "expiration", "col10", "col11",
  "wpl", "sg", "comp", "cpc", "adddate", "status",
];

function rowToObject(vals, headers) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = vals[i] !== undefined ? vals[i] : "";
  });
  if (!obj.domain && vals[0]) obj.domain = vals[0].trim();
  // Normalize common aliases
  if (obj.regcount !== undefined && obj.regCount === undefined) obj.regCount = obj.regcount;
  if (obj.regcount !== undefined && obj.reg_count === undefined) obj.reg_count = obj.regcount;
  return obj;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const firstVals = parseCSVLine(lines[0]);
  const firstCell = firstVals[0]?.trim() || "";

  // Header row: first cell is "domain" or similar label, not an actual domain
  const hasHeader = !looksLikeDomain(firstCell) && (
    /^domain$/i.test(firstCell) ||
    /domain|backlinks|length|len|wby|aby/i.test(lines[0])
  );

  if (hasHeader) {
    const headers = firstVals.map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    return lines.slice(1).map((line) => rowToObject(parseCSVLine(line), headers));
  }

  // No header — every line is a domain row (ExpiredDomains spreadsheet export)
  return lines.map((line) => rowToObject(parseCSVLine(line), HEADERLESS_COLUMNS));
}

function rowsToItems(rows) {
  return rows.map((r) => ({
    domain: r.domain || r.Domain || Object.values(r)[0] || "-",
    row_data: r,
  })).filter((x) => x.domain && x.domain !== "-" && looksLikeDomain(x.domain));
}

window.ParseDomains = { parseExpiredDomainsHTML, parseCSV, parseCSVLine, rowsToItems, looksLikeDomain };
