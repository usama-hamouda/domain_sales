const { api, toast, esc } = window.AppAPI;

let currentCampaignId = null;
let campTable = null;
const LS_LAST_CAMPAIGN = "domainSales.lastCampaignId";

const CAMP_COLS = [
  { key: "domain", label: "Domain", sortable: true },
  { key: "google_exact", label: "G-Exact", sortable: true, numeric: true },
  { key: "google_partial", label: "G-Part", sortable: true, numeric: true },
  { key: "linkedin_exact", label: "LinkedIn", sortable: true, numeric: true },
  { key: "instagram_exact", label: "Instagram", sortable: true, numeric: true },
  { key: "zfbot_count", label: "ZFBot", sortable: true, numeric: true },
  { key: "crunchbase_exact", label: "Crunchbase", sortable: true, numeric: true },
];

export async function initCampaignsModule(root) {
  root.innerHTML = `
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header"><span>Campaigns</span></div>
        <div class="sidebar-list" id="campSidebar"></div>
      </aside>
      <div class="main-panel">
        <div class="toolbar">
          <span class="toolbar-title" id="campTitle">Select a campaign</span>
          <button class="warn" id="btnDeleteDomain" disabled>Delete Selected</button>
        </div>
        <div id="campTableHost" class="flex-table-host"></div>
      </div>
    </div>
  `;

  document.getElementById("btnDeleteDomain").onclick = deleteSelected;
  const camps = await loadCampaignSidebar();
  if (currentCampaignId) {
    await loadCampaign(currentCampaignId);
  } else if (camps.length) {
    const saved = Number(localStorage.getItem(LS_LAST_CAMPAIGN));
    const pick = camps.find((c) => c.id === saved)?.id ?? camps[0].id;
    await loadCampaign(pick);
  }
}

async function loadCampaignSidebar() {
  const camps = await api("/api/campaigns");
  const el = document.getElementById("campSidebar");
  el.innerHTML = camps.map((c) => `
    <div class="sidebar-item ${c.id === currentCampaignId ? "active" : ""}" data-id="${c.id}">
      <div>${esc(c.name)}</div>
      <div class="meta">${c.domain_count} domains</div>
    </div>
  `).join("") || `<div style="padding:12px;color:var(--text-dim);font-size:12px">No campaigns yet</div>`;

  el.querySelectorAll(".sidebar-item").forEach((item) => {
    item.onclick = () => loadCampaign(Number(item.dataset.id));
  });
  return camps;
}

let selectedCampDomainIds = [];

async function loadCampaign(id) {
  currentCampaignId = id;
  localStorage.setItem(LS_LAST_CAMPAIGN, String(id));
  const camp = await api(`/api/campaigns/${id}`);
  document.getElementById("campTitle").textContent = camp.name;

  const rows = camp.domains.map((d) => ({ ...d, id: d.id }));

  const host = document.getElementById("campTableHost");
  campTable = new DataTable(host, {
    columns: CAMP_COLS,
    rows,
    stickyKey: "domain",
    rowActions: [
      { id: "detail", icon: "📋", title: "Domain details" },
      { id: "market", icon: "📣", title: "Marketing page" },
      { id: "final", icon: "★", title: "Final prospects" },
    ],
    onSelectionChange: (ids) => {
      selectedCampDomainIds = ids;
      document.getElementById("btnDeleteDomain").disabled = !ids.length;
    },
    onRowAction: (action, row) => {
      if (action === "detail") {
        window.AppRouter.navigate("domain-detail", { campaignDomainId: row.id });
      } else if (action === "market") {
        window.AppRouter.navigate("marketing", { campaignDomainId: row.id });
      } else if (action === "final") {
        window.AppRouter.navigate("final-prospects", { campaignDomainId: row.id });
      }
    },
  });

  await loadCampaignSidebar();
}

async function deleteSelected() {
  if (!currentCampaignId || !selectedCampDomainIds.length) return;
  if (!confirm(`Delete ${selectedCampDomainIds.length} domain(s) from campaign?`)) return;
  for (const id of selectedCampDomainIds) {
    await api(`/api/campaigns/${currentCampaignId}/domains/${id}`, { method: "DELETE" });
  }
  toast("Deleted");
  await loadCampaign(currentCampaignId);
}
