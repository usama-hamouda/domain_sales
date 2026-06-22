const { api, toast, esc } = window.AppAPI;
import { scrapeContactWithProgress } from "../utils/scrape-contact.js";
import {
  loadMarketingAccounts,
  renderAccountSelect,
  bindAccountAssign,
} from "../utils/account-assign.js";

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

let context = {};
let editingId = null;
let table = null;
let rows = [];
let marketingAccounts = [];

function getReturnParams() {
  if (context.campaignDomainId) {
    return { campaignDomainId: context.campaignDomainId };
  }
  return {
    listId: context.listId,
    listItemId: context.listItemId,
    domain: context.domain,
  };
}

function buildFinalProspectCols() {
  return [
    {
      key: "actions", label: "", sortable: false, stickyWidth: 168,
      render: (r) => `
        <div class="prospect-actions-cell">
          <button type="button" class="icon-btn" data-fp-action="outreach" data-id="${r.id}" title="Outreach">✉️</button>
          <button type="button" class="icon-btn" data-fp-action="edit" data-id="${r.id}" title="Edit">✏️</button>
          <button type="button" class="icon-btn" data-fp-action="scrape" data-id="${r.id}" title="Scrape website">🔍</button>
          <button type="button" class="icon-btn" data-fp-action="delete" data-id="${r.id}" title="Remove">🗑</button>
        </div>
      `,
    },
    {
      key: "name", label: "Name", sortable: true, stickyWidth: 200,
      render: (r) => `<span title="${esc(r.name || "—")}" style="display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">${esc(r.name || "—")}</span>`,
    },
    {
      key: "marketing_account", label: "Mkt Account", sortable: false,
      render: (r) => renderAccountSelect(r, marketingAccounts, { mode: "final" }),
    },
    {
      key: "website", label: "Website", sortable: true,
      render: (r) => r.website
        ? `<a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer" title="${esc(r.website)}" style="display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">${esc(r.website)}</a>`
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
    { key: "twitter", label: "Twitter", sortable: true },
    { key: "source", label: "Source", sortable: true, render: (r) => esc(SOURCE_LABEL[r.source] || r.source || r.step || "—") },
    { key: "match_type", label: "Match", sortable: true },
    { key: "notes", label: "Notes", sortable: true },
    { key: "scrape_status", label: "Scrape", sortable: true },
  ];
}

export async function initFinalProspectsModule(root, params = {}) {
  context = { ...params };
  let domain = params.domain || "Domain";
  rows = [];

  if (params.campaignDomainId) {
    const cd = await api(`/api/campaign-domains/${params.campaignDomainId}`);
    domain = cd.domain;
    context.campaignDomainId = params.campaignDomainId;
    context.listItemId = cd.list_item_id;
    rows = await api(`/api/campaign-domains/${params.campaignDomainId}/final-prospects`);
  } else if (params.listId && params.listItemId) {
    const list = await api(`/api/lists/${params.listId}`);
    const item = list.items?.find((i) => i.id === Number(params.listItemId));
    domain = item?.domain || domain;
    context.listId = params.listId;
    context.listItemId = params.listItemId;
    rows = await api(`/api/lists/${params.listId}/items/${params.listItemId}/final-prospects`);
  } else {
    root.innerHTML = `<div style="padding:24px;color:var(--text-dim)">No domain selected for final prospects.</div>`;
    return;
  }

  context.domain = domain;
  marketingAccounts = await loadMarketingAccounts();

  root.innerHTML = `
    <div class="main-panel">
      <div class="toolbar">
        <button id="btnFinalBack">← Back</button>
        <span class="toolbar-title">${esc(domain)} — Final Prospects</span>
        <span class="stat-chip">Total: <span>${rows.length}</span></span>
      </div>
      <div class="detail-panel" style="padding-top:0">
        <div class="card" style="margin-bottom:0">
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px">
            Curated prospects for outreach. Assign a marketing account per prospect below, or let round-robin auto-assign when added.
          </p>
          <div id="finalProspectTableHost" class="flex-table-host"></div>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="finalEditModal">
      <div class="modal" style="min-width:420px">
        <h3>Edit Final Prospect</h3>
        <div class="field"><label>Name</label><input type="text" id="feName"></div>
        <div class="field"><label>Website</label><input type="text" id="feWebsite"></div>
        <div class="field"><label>Email</label><input type="email" id="feEmail"></div>
        <div class="field"><label>Phone (WhatsApp)</label><input type="text" id="fePhone" placeholder="+1234567890"></div>
        <div class="field"><label>LinkedIn</label><input type="text" id="feLinkedin"></div>
        <div class="field"><label>Instagram</label><input type="text" id="feInstagram"></div>
        <div class="field"><label>Facebook</label><input type="text" id="feFacebook"></div>
        <div class="field"><label>Twitter</label><input type="text" id="feTwitter"></div>
        <div class="field"><label>Notes</label><input type="text" id="feNotes"></div>
        <div class="modal-actions">
          <button id="btnFinalEditCancel">Cancel</button>
          <button class="primary" id="btnFinalEditSave">Save</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btnFinalBack").onclick = () => {
    if (context.campaignDomainId) {
      window.AppRouter.navigate("marketing", { campaignDomainId: context.campaignDomainId });
    } else {
      window.AppRouter.navigate("lists");
    }
  };
  document.getElementById("btnFinalEditCancel").onclick = () => hideEditModal();
  document.getElementById("btnFinalEditSave").onclick = saveEdit;

  const host = document.getElementById("finalProspectTableHost");
  if (!rows.length) {
    host.innerHTML = `<p style="padding:12px;color:var(--text-dim)">No final prospects yet. Add them from processing results or marketing prospects.</p>`;
    return;
  }

  table = new DataTable(host, {
    columns: buildFinalProspectCols(),
    rows,
    stickyKeys: ["actions", "name"],
    selectable: false,
  });

  bindAccountAssign(host, marketingAccounts, (sel, out) => {
    const row = rows.find((r) => r.id === Number(sel.dataset.finalProspectId));
    if (row) row.account_assignments = out.assignments;
  });

  host.onclick = async (e) => {
    const btn = e.target.closest("[data-fp-action]");
    if (!btn) return;
    const row = rows.find((r) => r.id === Number(btn.dataset.id));
    if (!row) return;
    if (btn.dataset.fpAction === "outreach") await openOutreach(row);
    if (btn.dataset.fpAction === "edit") openEditModal(row);
    if (btn.dataset.fpAction === "scrape") await scrapeRow(row);
    if (btn.dataset.fpAction === "delete") await deleteRow(row);
  };
}

async function scrapeRow(row) {
  if (!row.website) {
    toast("No website to scrape");
    return;
  }
  await scrapeContactWithProgress({
    url: row.website,
    finalProspectId: row.id,
    onComplete: reload,
  });
}

async function openOutreach(row) {
  try {
    const out = await api(`/api/final-prospects/${row.id}/ensure-prospect`, { method: "POST" });
    window.AppRouter.navigate("outreach", {
      prospectId: out.prospectId,
      finalProspectId: row.id,
      returnTo: "final-prospects",
      returnParams: getReturnParams(),
    });
  } catch (e) {
    toast(e.message || "Could not open outreach");
  }
}

function hideEditModal() {
  document.getElementById("finalEditModal").classList.add("hidden");
  editingId = null;
}

function openEditModal(row) {
  editingId = row.id;
  document.getElementById("feName").value = row.name || "";
  document.getElementById("feWebsite").value = row.website || "";
  document.getElementById("feEmail").value = row.email || "";
  document.getElementById("fePhone").value = row.phone || row.whatsapp || "";
  document.getElementById("feLinkedin").value = row.linkedin || "";
  document.getElementById("feInstagram").value = row.instagram || "";
  document.getElementById("feFacebook").value = row.facebook || "";
  document.getElementById("feTwitter").value = row.twitter || "";
  document.getElementById("feNotes").value = row.notes || "";
  document.getElementById("finalEditModal").classList.remove("hidden");
}

async function saveEdit() {
  if (!editingId) return;
  await api(`/api/final-prospects/${editingId}`, {
    method: "PATCH",
    body: {
      name: document.getElementById("feName").value,
      website: document.getElementById("feWebsite").value,
      email: document.getElementById("feEmail").value,
      phone: document.getElementById("fePhone").value,
      linkedin: document.getElementById("feLinkedin").value,
      instagram: document.getElementById("feInstagram").value,
      facebook: document.getElementById("feFacebook").value,
      twitter: document.getElementById("feTwitter").value,
      notes: document.getElementById("feNotes").value,
    },
  });
  hideEditModal();
  toast("Final prospect updated");
  reload();
}

async function deleteRow(row) {
  if (!confirm(`Remove "${row.name || row.website}" from final prospects?`)) return;
  await api(`/api/final-prospects/${row.id}`, { method: "DELETE" });
  toast("Removed from final list");
  reload();
}

function reload() {
  window.AppRouter.navigate("final-prospects", getReturnParams());
}
