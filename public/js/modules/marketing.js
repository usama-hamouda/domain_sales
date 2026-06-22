const { api, toast, esc } = window.AppAPI;
import { scrapeContactWithProgress } from "../utils/scrape-contact.js";
import {
  loadMarketingAccounts,
  renderAccountSelect,
  bindAccountAssign,
} from "../utils/account-assign.js";

function showWarnings(warnings) {
  if (!warnings?.length) return;
  toast(warnings.join(" "), 8000);
}

let campaignDomainId = null;
let prospectTable = null;
let campDomain = null;
let processingResults = [];
let finalProspectResultIds = new Set();
let finalProspectProspectIds = new Set();
let activeTabKey = null;
let editingProspectId = null;
let marketingAccounts = [];

const SOURCE_ORDER = ["google_exact", "google_partial", "zfbot", "linkedin", "instagram", "crunchbase", "manual"];
const SOURCE_LABEL = {
  google_exact: "G-Exact",
  google_partial: "G-Part",
  google_serp: "Google",
  zfbot: "ZFBot",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  crunchbase: "Crunchbase",
  manual: "Manual",
};

function renderFinalToggleButton(inFinal, resultId) {
  return `<button type="button" class="icon-btn final-toggle-btn ${inFinal ? "final-added" : ""}" data-toggle-final-proc="${resultId}" data-in-final="${inFinal ? "1" : "0"}" title="${inFinal ? "Remove from final list" : "Add to final list"}">★</button>`;
}

function renderProspectStar(inFinal, rowId) {
  return `<button type="button" class="icon-btn final-toggle-btn ${inFinal ? "final-added" : ""}" data-inline-action="final" data-row="${rowId}" title="${inFinal ? "Remove from final list" : "Add to final list"}">★</button>`;
}

function setFinalListCount(n) {
  const btn = document.getElementById("btnManageFinal");
  if (btn) btn.textContent = `Final List (${n})`;
}

function updateProspectFinalUI(rowId, inFinal) {
  if (inFinal) finalProspectProspectIds.add(rowId);
  else finalProspectProspectIds.delete(rowId);
  const tr = document.querySelector(`#prospectTableHost tr[data-id="${rowId}"]`);
  if (!tr) return;
  tr.classList.toggle("in-final-row", inFinal);
  const star = tr.querySelector('[data-inline-action="final"]');
  if (star) {
    star.classList.toggle("final-added", inFinal);
    star.title = inFinal ? "Remove from final list" : "Add to final list";
  }
}

function updateProcessingFinalUI(resultId, inFinal) {
  if (inFinal) finalProspectResultIds.add(resultId);
  else finalProspectResultIds.delete(resultId);
  const btn = document.querySelector(`[data-toggle-final-proc="${resultId}"]`);
  const tr = btn?.closest("tr");
  if (!tr) return;
  tr.classList.toggle("in-final-row", inFinal);
  const td = btn?.parentElement;
  if (td) td.innerHTML = renderFinalToggleButton(inFinal, resultId);
}

async function syncFinalCount() {
  const list = await api(`/api/campaign-domains/${campaignDomainId}/final-prospects`).catch(() => []);
  setFinalListCount((list || []).length);
}

function renderProspectActions(r) {
  return `
    <div class="prospect-actions-cell">
      ${renderProspectStar(r._inFinal, r.id)}
      <button type="button" class="icon-btn" data-inline-action="outreach" data-row="${r.id}" title="Outreach">✉️</button>
      <button type="button" class="icon-btn" data-inline-action="edit" data-row="${r.id}" title="Edit">✏️</button>
      <button type="button" class="icon-btn" data-inline-action="scrape" data-row="${r.id}" title="Scrape website">🔍</button>
    </div>
  `;
}

function buildProspectCols() {
  return [
    {
      key: "actions", label: "", sortable: false, stickyWidth: 168,
      render: (r) => renderProspectActions(r),
    },
    {
      key: "name", label: "Name", sortable: true, stickyWidth: 200,
      render: (r) => `<span title="${esc(r.name || "—")}" style="display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">${esc(r.name || "—")}</span>`,
    },
    {
      key: "marketing_account", label: "Mkt Account", sortable: false,
      render: (r) => renderAccountSelect(r, marketingAccounts, { mode: "prospect" }),
    },
    {
      key: "website", label: "Website", sortable: true,
      render: (r) => r.website
        ? `<a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer" title="${esc(r.website)}" style="display:inline-block;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">${esc(r.website)}</a>`
        : "—",
    },
    { key: "email", label: "Email", sortable: true },
    { key: "phone", label: "Phone (WhatsApp)", sortable: true },
    {
      key: "linkedin", label: "LinkedIn", sortable: true,
      render: (r) => r.linkedin ? `<a href="${esc(r.linkedin)}" target="_blank" rel="noopener noreferrer">open</a>` : "—",
    },
    {
      key: "instagram", label: "Instagram", sortable: true,
      render: (r) => r.instagram ? `<a href="${esc(r.instagram)}" target="_blank" rel="noopener noreferrer">open</a>` : "—",
    },
    {
      key: "facebook", label: "Facebook", sortable: true,
      render: (r) => r.facebook ? `<a href="${esc(r.facebook)}" target="_blank" rel="noopener noreferrer">open</a>` : "—",
    },
    { key: "source", label: "Source", sortable: true, render: (r) => esc(SOURCE_LABEL[r.source] || r.source || "other") },
    { key: "scrape_status", label: "Scrape", sortable: true },
  ];
}

function renderTabbedProspects(prospects, columns, finalList = [], preferredTabKey = null) {
  const tabsHost = document.getElementById("prospectTabs");
  const host = document.getElementById("prospectTableHost");
  host.innerHTML = "";
  tabsHost.innerHTML = "";
  const grouped = new Map();
  for (const p of prospects) {
    const key = p.source || "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      ...p,
      id: p.id,
      _inFinal: finalProspectProspectIds.has(p.id),
    });
  }

  const keys = [
    ...SOURCE_ORDER.filter((k) => grouped.has(k)),
    ...[...grouped.keys()].filter((k) => !SOURCE_ORDER.includes(k)).sort(),
  ];

  if (processingResults.length) {
    keys.push("__processing_results__");
    grouped.set("__processing_results__", processingResults.map((r) => ({ ...r, id: r.id })));
  }

  if (!keys.length) {
    host.innerHTML = `<div class="card"><p style="color:var(--text-dim)">No prospects yet.</p></div>`;
    activeTabKey = null;
    return;
  }

  const renderTab = (key) => {
    activeTabKey = key;
    if (key === "__processing_results__") {
      host.innerHTML = renderProcessingResultsTable(grouped.get(key));
      return;
    }
    host.innerHTML = `<div id="prospectTable_${key}" style="display:flex;flex-direction:column;min-height:0"></div>`;
    const rows = grouped.get(key).map((r) => ({ ...r, actions: r.id }));
    prospectTable = new DataTable(host.querySelector(`#prospectTable_${CSS.escape(key)}`), {
      columns: buildProspectCols(),
      rows,
      stickyKeys: ["actions", "name"],
      selectable: false,
      rowClass: (r) => (r._inFinal ? "in-final-row" : ""),
    });
  };

  const defaultKey = preferredTabKey && keys.includes(preferredTabKey) ? preferredTabKey : keys[0];
  keys.forEach((key) => {
    const btn = document.createElement("button");
    const label = key === "__processing_results__"
      ? `Processing Results (${processingResults.length})`
      : `${SOURCE_LABEL[key] || key} (${grouped.get(key).length})`;
    btn.textContent = label;
    btn.className = key === defaultKey ? "primary" : "";
    btn.onclick = () => {
      tabsHost.querySelectorAll("button").forEach((b) => b.classList.remove("primary"));
      btn.classList.add("primary");
      renderTab(key);
    };
    tabsHost.appendChild(btn);
  });

  renderTab(defaultKey);
}

function renderProcessingResultsTable(results) {
  return `
    <table class="data-table result-table" style="width:100%">
      <thead>
        <tr>
          <th>Step</th><th>Final</th><th>Match</th><th>Domain</th><th>Title</th><th>URL</th>
        </tr>
      </thead>
      <tbody>
        ${results.map((r) => {
          const inFinal = finalProspectResultIds.has(r.id);
          return `
            <tr class="${inFinal ? "in-final-row" : ""}">
              <td>${esc(r.step || "-")}</td>
              <td>${renderFinalToggleButton(inFinal, r.id)}</td>
              <td>${esc(r.match_type || "-")}</td>
              <td>${esc(r.result_domain || "-")}</td>
              <td>${esc(r.title || "-")}</td>
              <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : "-"}</td>
            </tr>
          `;
        }).join("") || `<tr><td colspan="6">No processing results.</td></tr>`}
      </tbody>
    </table>
  `;
}

async function refreshMarketingSoft() {
  const scrollY = window.scrollY;
  const tab = activeTabKey;
  const tableScroll = document.querySelector("#prospectTableHost .table-scroll")?.scrollTop ?? 0;

  const [prospects, finalList, procResults] = await Promise.all([
    api(`/api/campaign-domains/${campaignDomainId}/prospects`),
    api(`/api/campaign-domains/${campaignDomainId}/final-prospects`).catch(() => []),
    api(`/api/campaign-domains/${campaignDomainId}/processing-results`).catch(() => []),
  ]);
  processingResults = procResults || [];
  finalProspectResultIds = new Set((finalList || []).map((f) => f.processing_result_id).filter(Boolean));
  finalProspectProspectIds = new Set((finalList || []).map((f) => f.prospect_id).filter(Boolean));
  setFinalListCount((finalList || []).length);
  renderTabbedProspects(prospects, buildProspectCols(), finalList, tab);

  requestAnimationFrame(() => {
    window.scrollTo(0, scrollY);
    const el = document.querySelector("#prospectTableHost .table-scroll");
    if (el) el.scrollTop = tableScroll;
  });
}

async function toggleProcessingResultFinal(processingResultId) {
  if (!campaignDomainId || !processingResultId) return;
  try {
    const out = await api(`/api/campaign-domains/${campaignDomainId}/final-prospects/toggle-result`, {
      method: "POST",
      body: { processingResultId },
    });
    updateProcessingFinalUI(processingResultId, out.inFinal);
    await syncFinalCount();
    toast(out.inFinal ? "Added to final prospects" : "Removed from final prospects");
    if (out.inFinal) showWarnings(out.warnings);
  } catch (e) {
    toast(e.message || "Failed to update final list");
  }
}

function openProspectModal(prospect = null) {
  editingProspectId = prospect?.id || null;
  document.getElementById("prospectModalTitle").textContent = prospect ? "Edit Prospect" : "Add Prospect";
  document.getElementById("pName").value = prospect?.name || "";
  document.getElementById("pWebsite").value = prospect?.website || "";
  document.getElementById("pEmail").value = prospect?.email || "";
  document.getElementById("pPhone").value = prospect?.phone || prospect?.whatsapp || "";
  document.getElementById("pLinkedin").value = prospect?.linkedin || "";
  document.getElementById("pInstagram").value = prospect?.instagram || "";
  document.getElementById("pFacebook").value = prospect?.facebook || "";
  document.getElementById("prospectModal").classList.remove("hidden");
}

async function saveProspect() {
  const body = {
    name: document.getElementById("pName").value.trim(),
    website: document.getElementById("pWebsite").value.trim(),
    email: document.getElementById("pEmail").value.trim(),
    phone: document.getElementById("pPhone").value.trim(),
    linkedin: document.getElementById("pLinkedin").value.trim(),
    instagram: document.getElementById("pInstagram").value.trim(),
    facebook: document.getElementById("pFacebook").value.trim(),
    source: "manual",
  };
  try {
    if (editingProspectId) {
      await api(`/api/prospects/${editingProspectId}`, { method: "PATCH", body });
    } else {
      await api(`/api/campaign-domains/${campaignDomainId}/prospects`, { method: "POST", body });
    }
    document.getElementById("prospectModal").classList.add("hidden");
    toast("Saved");
    await refreshMarketingSoft();
  } catch (e) {
    toast(e.message || "Failed to save prospect");
  }
}

async function importFromResults() {
  const r = await api(`/api/campaign-domains/${campaignDomainId}/prospects/from-results`, {
    method: "POST",
    body: { mode: "overwrite" },
  });
  const parts = [];
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.added) parts.push(`${r.added} added`);
  toast(parts.length ? `Prospects synced: ${parts.join(", ")}` : "Prospects already up to date");
  await refreshMarketingSoft();
}

async function handleProspectAction(action, row) {
  if (action === "final") {
    try {
      const out = await api(`/api/campaign-domains/${campaignDomainId}/final-prospects/toggle-prospect`, {
        method: "POST",
        body: { prospectId: row.id },
      });
      row._inFinal = out.inFinal;
      updateProspectFinalUI(row.id, out.inFinal);
      await syncFinalCount();
      toast(out.inFinal ? "Added to final prospects" : "Removed from final prospects");
      if (out.inFinal) showWarnings(out.warnings);
    } catch (e) {
      toast(e.message || "Failed to update final list");
    }
    return;
  }
  if (action === "outreach") {
    window.AppRouter.navigate("outreach", {
      prospectId: row.id,
      returnTo: "marketing",
      returnParams: { campaignDomainId },
    });
  } else if (action === "edit") {
    openProspectModal(row);
  } else if (action === "scrape") {
    if (!row.website) { toast("No website to scrape"); return; }
    await scrapeContactWithProgress({
      url: row.website,
      prospectId: row.id,
      onComplete: refreshMarketingSoft,
    });
  }
}

export async function initMarketingModule(root, params = {}) {
  campaignDomainId = params.campaignDomainId;
  if (!campaignDomainId) {
    root.innerHTML = `<div style="padding:24px;color:var(--text-dim)">No domain selected. Open from Campaigns module.</div>`;
    return;
  }

  campDomain = await api(`/api/campaign-domains/${campaignDomainId}`);
  marketingAccounts = await loadMarketingAccounts();
  const [prospects, finalList, procResults] = await Promise.all([
    api(`/api/campaign-domains/${campaignDomainId}/prospects`),
    api(`/api/campaign-domains/${campaignDomainId}/final-prospects`).catch(() => []),
    api(`/api/campaign-domains/${campaignDomainId}/processing-results`).catch(() => []),
  ]);
  processingResults = procResults || [];
  finalProspectResultIds = new Set((finalList || []).map((f) => f.processing_result_id).filter(Boolean));
  finalProspectProspectIds = new Set((finalList || []).map((f) => f.prospect_id).filter(Boolean));

  root.innerHTML = `
    <div class="main-panel">
      <div class="toolbar">
        <button onclick="window.AppRouter.navigate('campaigns')">← Campaigns</button>
        <span class="toolbar-title">${esc(campDomain.domain)} — Prospects</span>
        <button class="success" id="btnManageFinal">Final List (${(finalList || []).length})</button>
        <button class="success" id="btnFromResults">Sync from Processing</button>
        <button class="primary" id="btnAddProspect">+ Add Prospect</button>
      </div>
      <div class="detail-panel">
        <div class="card">
          <h4>Domain Info</h4>
          <div style="font-family:JetBrains Mono;font-size:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
            <div>G-Exact: <b>${campDomain.google_exact || 0}</b></div>
            <div>G-Partial: <b>${campDomain.google_partial || 0}</b></div>
            <div>LinkedIn: <b>${campDomain.linkedin_exact || 0}</b></div>
            <div>Instagram: <b>${campDomain.instagram_exact || 0}</b></div>
            <div>ZFBot: <b>${campDomain.zfbot_count || 0}</b></div>
            <div>Crunchbase: <b>${campDomain.crunchbase_exact || 0}</b></div>
          </div>
        </div>
        <div class="card" style="padding-bottom:8px">
          <div id="prospectTabs" style="display:flex;gap:8px;flex-wrap:wrap"></div>
        </div>
        <div id="prospectTableHost" class="flex-table-host"></div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="prospectModal">
      <div class="modal" style="min-width:420px">
        <h3 id="prospectModalTitle">Add Prospect</h3>
        <div class="field"><label>Name</label><input type="text" id="pName"></div>
        <div class="field"><label>Website</label><input type="text" id="pWebsite"></div>
        <div class="field"><label>Email</label><input type="email" id="pEmail"></div>
        <div class="field"><label>Phone (WhatsApp)</label><input type="text" id="pPhone" placeholder="+1234567890"></div>
        <div class="field"><label>LinkedIn</label><input type="text" id="pLinkedin"></div>
        <div class="field"><label>Instagram</label><input type="text" id="pInstagram"></div>
        <div class="field"><label>Facebook</label><input type="text" id="pFacebook"></div>
        <div class="modal-actions">
          <button type="button" id="btnProspectCancel">Cancel</button>
          <button type="button" class="primary" id="btnProspectSave">Save</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("prospectTableHost").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-inline-action]");
    if (btn) {
      const row = prospectTable?.rows?.find((r) => r.id === Number(btn.dataset.row));
      if (row) handleProspectAction(btn.dataset.inlineAction, row);
      return;
    }
    const procBtn = e.target.closest("[data-toggle-final-proc]");
    if (procBtn) toggleProcessingResultFinal(Number(procBtn.dataset.toggleFinalProc));
  });

  bindAccountAssign(document.getElementById("prospectTableHost"), marketingAccounts, async (sel, out) => {
    const row = prospectTable?.rows?.find((r) => r.id === Number(sel.dataset.prospectId));
    if (row) {
      row.account_assignments = out.assignments;
      row.final_prospect_id = row.final_prospect_id || sel.dataset.finalProspectId || null;
    }
  });

  document.getElementById("btnAddProspect").onclick = () => openProspectModal();
  document.getElementById("btnManageFinal").onclick = () => {
    window.AppRouter.navigate("final-prospects", { campaignDomainId });
  };
  document.getElementById("btnFromResults").onclick = importFromResults;
  document.getElementById("btnProspectCancel").onclick = () => document.getElementById("prospectModal").classList.add("hidden");
  document.getElementById("btnProspectSave").onclick = saveProspect;

  renderTabbedProspects(prospects, buildProspectCols(), finalList);
}
