const { api, toast, esc } = window.AppAPI;

const LS_LAST_ACCOUNT = "domainSales.lastMarketingAccountId";

const CHANNEL_FIELDS = [
  { key: "email", label: "Email (Gmail)", placeholder: "sales@company.com" },
  { key: "whatsapp", label: "WhatsApp", placeholder: "+1234567890 or wa.me link" },
  { key: "linkedin", label: "LinkedIn", placeholder: "Profile URL or username" },
  { key: "instagram", label: "Instagram", placeholder: "Profile URL or @handle" },
  { key: "facebook", label: "Facebook", placeholder: "Profile or page URL" },
];

let currentAccountId = null;
let channels = [];
let maxProspects = 50;
let followUpInterval = 5;
let accountProspects = [];
let prospectFilter = "all";

const PROSPECT_FILTERS = [
  { value: "all", label: "All prospects" },
  { value: "due_today", label: "Due today" },
];

function isMobileTableLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function showWarnings(warnings) {
  if (!warnings?.length) return;
  toast(warnings.join(" "), 8000);
}

window.AppAPI.showAssignmentWarnings = showWarnings;

function formatChannelSummary(account) {
  const labels = account.channel_labels || account.configured_channels || [];
  if (labels.length) return labels.join(", ");
  return "No channels configured";
}

export async function initMarketingAccountsModule(root, params = {}) {
  if (params.accountId) currentAccountId = Number(params.accountId);
  if (params.filter) prospectFilter = params.filter;

  const meta = await api("/api/marketing-accounts/channels");
  channels = meta.channels || [];
  const settings = await api("/api/marketing-accounts/settings");
  maxProspects = settings.maxProspectsPerAccount ?? 50;
  followUpInterval = settings.followUpIntervalDays ?? 5;

  root.innerHTML = `
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header">
          <span>Accounts</span>
          <button class="icon-btn" id="btnAddAccount" title="Add account">+</button>
        </div>
        <div class="sidebar-list" id="accountSidebar"></div>
        <div class="sidebar-footer" style="padding:10px;border-top:1px solid var(--border)">
          <label style="font-size:11px;color:var(--text-dim);display:block;margin-bottom:4px">Max prospects / account</label>
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <input type="number" id="maxProspectsInput" min="1" value="${maxProspects}" style="flex:1;font-size:12px">
            <button id="btnSaveMax" style="font-size:11px">Save</button>
          </div>
          <label style="font-size:11px;color:var(--text-dim);display:block;margin-bottom:4px">Days between follow-ups</label>
          <div style="display:flex;gap:6px">
            <input type="number" id="followUpIntervalInput" min="1" value="${followUpInterval}" style="flex:1;font-size:12px">
            <button id="btnSaveInterval" style="font-size:11px">Save</button>
          </div>
        </div>
      </aside>
      <div class="main-panel">
        <div class="toolbar">
          <span class="toolbar-title" id="accountTitle">Select an account</span>
          <button id="btnEditAccount" class="hidden">Edit</button>
          <button id="btnDeleteAccount" class="warn hidden">Delete</button>
        </div>
        <div id="accountMainHost" class="flex-table-host" style="padding:12px">
          <p style="color:var(--text-dim);font-size:13px">Manage marketing accounts used for outreach. Each account can include email, WhatsApp, LinkedIn, and other channels. Prospects on the final list are assigned one account in round-robin order.</p>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="accountModal">
      <div class="modal" style="min-width:460px;max-height:90vh;overflow-y:auto">
        <h3 id="accountModalTitle">Add Marketing Account</h3>
        <div class="field"><label>Name</label><input type="text" id="accName" placeholder="e.g. Sales Team 1"></div>
        <p style="font-size:12px;color:var(--text-dim);margin:0 0 10px">Add at least one channel. All filled channels will be used when reaching prospects assigned to this account.</p>
        ${CHANNEL_FIELDS.map((f) => `
          <div class="field">
            <label>${esc(f.label)}</label>
            <input type="text" id="acc_${f.key}" placeholder="${esc(f.placeholder)}">
          </div>
        `).join("")}
        <div class="field"><label>Notes</label><input type="text" id="accNotes"></div>
        <div class="field"><label><input type="checkbox" id="accActive" checked> Active</label></div>
        <div class="modal-actions">
          <button id="btnAccountCancel">Cancel</button>
          <button class="primary" id="btnAccountSave">Save</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btnAddAccount").onclick = () => openAccountModal();
  document.getElementById("btnAccountCancel").onclick = () => hideAccountModal();
  document.getElementById("btnAccountSave").onclick = saveAccount;
  document.getElementById("btnEditAccount").onclick = () => editCurrentAccount();
  document.getElementById("btnDeleteAccount").onclick = deleteCurrentAccount;
  document.getElementById("btnSaveMax").onclick = saveMaxSetting;
  document.getElementById("btnSaveInterval").onclick = saveIntervalSetting;

  const accounts = await loadAccountSidebar();
  if (params.accountId) {
    await loadAccountDetail(Number(params.accountId));
  } else if (currentAccountId) {
    await loadAccountDetail(currentAccountId);
  } else if (accounts.length) {
    const saved = Number(localStorage.getItem(LS_LAST_ACCOUNT));
    const pick = accounts.find((a) => a.id === saved)?.id ?? accounts[0].id;
    await loadAccountDetail(pick);
  }
}

async function loadAccountSidebar() {
  const accounts = await api("/api/marketing-accounts");
  const el = document.getElementById("accountSidebar");
  el.innerHTML = accounts.map((a) => `
    <div class="sidebar-item ${a.id === currentAccountId ? "active" : ""} ${a.exhausted ? "account-exhausted" : ""}" data-id="${a.id}">
      <div>${esc(a.name)}</div>
      <div class="meta">${esc(formatChannelSummary(a))} · ${a.usage_count}/${a.max_prospects}${a.exhausted ? " · FULL" : ""}</div>
    </div>
  `).join("") || `<div style="padding:12px;color:var(--text-dim);font-size:12px">No accounts yet. Click + to add.</div>`;

  el.querySelectorAll(".sidebar-item").forEach((item) => {
    item.onclick = () => loadAccountDetail(Number(item.dataset.id));
  });
  return accounts;
}

let editingAccountId = null;

function openAccountModal(account = null) {
  editingAccountId = account?.id || null;
  document.getElementById("accountModalTitle").textContent = account ? "Edit Marketing Account" : "Add Marketing Account";
  document.getElementById("accName").value = account?.name || "";
  for (const f of CHANNEL_FIELDS) {
    document.getElementById(`acc_${f.key}`).value = account?.[f.key] || "";
  }
  document.getElementById("accNotes").value = account?.notes || "";
  document.getElementById("accActive").checked = account ? !!account.is_active : true;
  document.getElementById("accountModal").classList.remove("hidden");
}

function hideAccountModal() {
  document.getElementById("accountModal").classList.add("hidden");
  editingAccountId = null;
}

function readAccountFormBody() {
  const body = {
    name: document.getElementById("accName").value.trim(),
    notes: document.getElementById("accNotes").value.trim(),
    is_active: document.getElementById("accActive").checked,
  };
  for (const f of CHANNEL_FIELDS) {
    body[f.key] = document.getElementById(`acc_${f.key}`).value.trim();
  }
  return body;
}

async function saveAccount() {
  const body = readAccountFormBody();
  try {
    if (editingAccountId) {
      await api(`/api/marketing-accounts/${editingAccountId}`, { method: "PATCH", body });
    } else {
      await api("/api/marketing-accounts", { method: "POST", body });
    }
    hideAccountModal();
    toast("Account saved");
    await loadAccountSidebar();
    if (currentAccountId) await loadAccountDetail(currentAccountId);
  } catch (e) {
    toast(e.message || "Failed to save account");
  }
}

async function saveIntervalSetting() {
  const val = Number(document.getElementById("followUpIntervalInput").value);
  try {
    const out = await api("/api/marketing-accounts/settings", {
      method: "PATCH",
      body: { followUpIntervalDays: val },
    });
    followUpInterval = out.followUpIntervalDays ?? val;
    toast("Follow-up interval saved");
    if (currentAccountId) await loadAccountDetail(currentAccountId);
  } catch (e) {
    toast(e.message || "Failed to save interval");
  }
}

async function saveMaxSetting() {
  const val = Number(document.getElementById("maxProspectsInput").value);
  try {
    const out = await api("/api/marketing-accounts/settings", {
      method: "PATCH",
      body: { maxProspectsPerAccount: val },
    });
    maxProspects = out.maxProspectsPerAccount;
    toast("Max prospects setting saved");
    await loadAccountSidebar();
    if (currentAccountId) await loadAccountDetail(currentAccountId);
  } catch (e) {
    toast(e.message || "Failed to save setting");
  }
}

async function editCurrentAccount() {
  if (!currentAccountId) return;
  const account = await api(`/api/marketing-accounts/${currentAccountId}`);
  openAccountModal(account);
}

async function deleteCurrentAccount() {
  if (!currentAccountId) return;
  if (!confirm("Delete this marketing account? Existing assignments will be removed.")) return;
  await api(`/api/marketing-accounts/${currentAccountId}`, { method: "DELETE" });
  toast("Account deleted");
  currentAccountId = null;
  localStorage.removeItem(LS_LAST_ACCOUNT);
  document.getElementById("btnEditAccount").classList.add("hidden");
  document.getElementById("btnDeleteAccount").classList.add("hidden");
  document.getElementById("accountTitle").textContent = "Select an account";
  document.getElementById("accountMainHost").innerHTML = `<p style="color:var(--text-dim);font-size:13px">Select an account from the sidebar to view assigned prospects.</p>`;
  await loadAccountSidebar();
}

function renderChannelGrid(account) {
  const configured = CHANNEL_FIELDS.filter((f) => account[f.key]);
  if (!configured.length) {
    return `<p style="color:var(--text-dim);font-size:12px">No channels configured.</p>`;
  }
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;font-size:12px">
      ${configured.map((f) => `
        <div>
          <span style="color:var(--text-dim)">${esc(f.label)}</span><br>
          <b>${esc(account[f.key])}</b>
        </div>
      `).join("")}
    </div>
  `;
}

function formatStatusLabel(status) {
  const labels = {
    sent: "Sent",
    scheduled: "Scheduled",
    due: "Due today",
    overdue: "Overdue",
    draft: "Draft",
  };
  return labels[status] || status;
}

function renderMessageSlotCell(msg) {
  if (!msg) return `<span style="color:var(--text-dim)">—</span>`;
  const sentLine = msg.sent_at
    ? `<div class="msg-date" title="Sent">✓ ${esc(new Date(msg.sent_at).toLocaleDateString())}</div>`
    : "";
  return `
    <div class="msg-slot-cell">
      <span class="msg-status ${esc(msg.status)}">${esc(formatStatusLabel(msg.status))}</span>
      <div class="msg-date">${esc(msg.scheduled_date || "")}</div>
      ${sentLine}
    </div>
  `;
}

function hasMessageDueToday(prospect) {
  return (prospect.message_tracking?.messages || []).some((m) => m.status === "due");
}

function filterProspects(prospects, filter) {
  if (filter === "due_today") {
    return prospects.filter(hasMessageDueToday);
  }
  return prospects;
}

function getReturnParams() {
  return { accountId: currentAccountId, filter: prospectFilter };
}

function renderProspectFilterBar(totalCount, visibleCount) {
  const options = PROSPECT_FILTERS.map((f) =>
    `<option value="${f.value}" ${prospectFilter === f.value ? "selected" : ""}>${esc(f.label)}</option>`
  ).join("");
  const countLabel = prospectFilter === "all"
    ? `${totalCount} prospect${totalCount === 1 ? "" : "s"}`
    : `${visibleCount} of ${totalCount} prospect${totalCount === 1 ? "" : "s"}`;
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <label style="font-size:12px;color:var(--text-dim)">Filter</label>
      <select id="prospectFilterSelect" style="font-size:12px;min-width:160px">${options}</select>
      <span style="font-size:11px;color:var(--text-dim)">${esc(countLabel)}</span>
    </div>
  `;
}

function renderProspectTrackingTable(prospects, totalCount) {
  const slotHeaders = ["Initial", "FU 1", "FU 2", "FU 3", "FU 4"];
  const mobile = isMobileTableLayout();
  const prospectStickyCls = mobile ? "" : "sticky-col";
  const prospectStickyStyle = mobile ? "" : ' style="left:0"';
  if (!prospects.length) {
    return `
      ${renderProspectFilterBar(totalCount, 0)}
      <p style="padding:12px;color:var(--text-dim);font-size:12px">No prospects match this filter.</p>
    `;
  }
  return `
    ${renderProspectFilterBar(totalCount, prospects.length)}
    <div class="msg-tracking-wrap">
      <div class="msg-tracking-legend">
        <span><span class="msg-status draft">Draft</span> not scheduled</span>
        <span><span class="msg-status scheduled">Scheduled</span> upcoming</span>
        <span><span class="msg-status due">Due today</span></span>
        <span><span class="msg-status overdue">Overdue</span></span>
        <span><span class="msg-status sent">Sent</span></span>
      </div>
      <div class="table-container" style="flex:1;min-height:0">
        <div class="table-scroll">
          <table class="data-table msg-tracking-table${mobile ? " data-table--mobile" : ""}">
            <thead>
              <tr>
                <th class="${prospectStickyCls}"${prospectStickyStyle}>Prospect</th>
                <th>Domain</th>
                <th>Start date</th>
                ${slotHeaders.map((h) => `<th>${esc(h)}</th>`).join("")}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${prospects.map((p) => {
                const tracking = p.message_tracking || {};
                const msgs = tracking.messages || [];
                const fpId = p.final_prospect_id;
                return `
                  <tr data-fp-id="${fpId}">
                    <td class="${prospectStickyCls}"${prospectStickyStyle}>
                      <div>${esc(p.name || p.website || "—")}</div>
                      <div style="font-size:10px;color:var(--text-dim)">${esc(p.website || "")}</div>
                    </td>
                    <td>${esc(p.campaign_domain || p.list_domain || "—")}</td>
                    <td>
                      <input type="date" class="tracking-start-date" data-fp-id="${fpId}" value="${esc(tracking.start_date || "")}">
                    </td>
                    ${msgs.map((m) => `<td>${renderMessageSlotCell(m)}</td>`).join("")}
                    <td>
                      <div class="msg-tracking-actions">
                        <button data-reset-dates="${fpId}" title="Set a new start date and recalculate all message dates">Reset dates</button>
                        <button data-reset-status="${fpId}" title="Clear sent status on all messages">Reset status</button>
                        <button data-open-outreach="${fpId}" title="Open outreach composer">✉️ Outreach</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function bindProspectTrackingEvents(host) {
  const filterSelect = host.querySelector("#prospectFilterSelect");
  if (filterSelect) {
    filterSelect.onchange = () => {
      prospectFilter = filterSelect.value;
      renderProspectTable();
    };
  }

  host.querySelectorAll(".tracking-start-date").forEach((input) => {
    input.onchange = async () => {
      const fpId = Number(input.dataset.fpId);
      if (!input.value) return;
      try {
        await api(`/api/final-prospects/${fpId}/message-tracking`, {
          method: "PATCH",
          body: { startDate: input.value },
        });
        toast("Start date updated");
        await loadAccountDetail(currentAccountId);
      } catch (e) {
        toast(e.message || "Failed to update start date");
      }
    };
  });

  host.onclick = async (e) => {
    const outreachBtn = e.target.closest("[data-open-outreach]");
    if (outreachBtn) {
      await openProspectOutreach(Number(outreachBtn.dataset.openOutreach));
      return;
    }

    const resetDatesBtn = e.target.closest("[data-reset-dates]");
    if (resetDatesBtn) {
      const fpId = Number(resetDatesBtn.dataset.resetDates);
      const row = host.querySelector(`tr[data-fp-id="${fpId}"]`);
      const current = row?.querySelector(".tracking-start-date")?.value || todayStr();
      const newDate = prompt("Reset start date — all message dates will be recalculated from this date (YYYY-MM-DD):", current);
      if (!newDate) return;
      try {
        await api(`/api/final-prospects/${fpId}/message-tracking/reset-dates`, {
          method: "POST",
          body: { startDate: newDate },
        });
        toast("Message dates reset");
        await loadAccountDetail(currentAccountId);
      } catch (e) {
        toast(e.message || "Failed to reset dates");
      }
      return;
    }

    const resetStatusBtn = e.target.closest("[data-reset-status]");
    if (resetStatusBtn) {
      const fpId = Number(resetStatusBtn.dataset.resetStatus);
      if (!confirm("Reset all message statuses to Draft? Sent dates will be cleared.")) return;
      try {
        await api(`/api/final-prospects/${fpId}/message-tracking/reset-status`, { method: "POST" });
        toast("Message statuses reset");
        await loadAccountDetail(currentAccountId);
      } catch (e) {
        toast(e.message || "Failed to reset status");
      }
    }
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function renderProspectTable() {
  const pHost = document.getElementById("accountProspectHost");
  if (!pHost) return;
  if (!accountProspects.length) {
    pHost.innerHTML = `<p style="padding:12px;color:var(--text-dim);font-size:12px">No prospects assigned yet. Add prospects to the final list to auto-assign accounts.</p>`;
    return;
  }
  const visible = filterProspects(accountProspects, prospectFilter);
  pHost.innerHTML = renderProspectTrackingTable(visible, accountProspects.length);
  bindProspectTrackingEvents(pHost);
}

async function loadAccountDetail(id) {
  currentAccountId = id;
  localStorage.setItem(LS_LAST_ACCOUNT, String(id));

  const [account, prospects] = await Promise.all([
    api(`/api/marketing-accounts/${id}`),
    api(`/api/marketing-accounts/${id}/prospects`),
  ]);
  accountProspects = prospects;

  document.getElementById("accountTitle").textContent = account.name;
  document.getElementById("btnEditAccount").classList.remove("hidden");
  document.getElementById("btnDeleteAccount").classList.remove("hidden");

  const host = document.getElementById("accountMainHost");
  const exhaustedBanner = account.exhausted
    ? `<div class="warn-banner" style="background:rgba(255,180,0,0.15);border:1px solid rgba(255,180,0,0.4);padding:10px;border-radius:6px;margin-bottom:12px;font-size:13px">⚠ This account has reached max capacity (${account.usage_count}/${account.max_prospects} prospects). Add more accounts or raise the limit.</div>`
    : "";

  host.innerHTML = `
    ${exhaustedBanner}
    <div class="card" style="margin-bottom:12px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;font-size:12px;margin-bottom:10px">
        <div><span style="color:var(--text-dim)">Usage</span><br><b>${account.usage_count} / ${account.max_prospects}</b></div>
        <div><span style="color:var(--text-dim)">Status</span><br><b>${account.is_active ? "Active" : "Inactive"}</b></div>
        ${account.notes ? `<div style="grid-column:1/-1"><span style="color:var(--text-dim)">Notes</span><br>${esc(account.notes)}</div>` : ""}
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">Configured channels</div>
      ${renderChannelGrid(account)}
    </div>
    <h4 style="margin:0 0 8px;font-size:13px">Prospects & message tracking</h4>
    <div id="accountProspectHost" class="flex-table-host" style="min-height:200px"></div>
  `;

  const pHost = document.getElementById("accountProspectHost");
  renderProspectTable();

  await loadAccountSidebar();
}

async function openProspectOutreach(finalProspectId) {
  const row = accountProspects.find((p) => p.final_prospect_id === finalProspectId);
  const knownProspectId = row?.prospect_id || row?.linked_prospect_id;

  try {
    if (knownProspectId) {
      window.AppRouter.navigate("outreach", {
        prospectId: knownProspectId,
        finalProspectId,
        returnTo: "marketing-accounts",
        returnParams: getReturnParams(),
      });
      api(`/api/final-prospects/${finalProspectId}/ensure-prospect`, {
        method: "POST",
        body: { prospectId: knownProspectId },
      }).catch(() => {});
      return;
    }

    const body = {};
    if (row?.campaign_domain_id) body.campaignDomainId = row.campaign_domain_id;
    const out = await api(`/api/final-prospects/${finalProspectId}/ensure-prospect`, {
      method: "POST",
      body,
    });
    window.AppRouter.navigate("outreach", {
      prospectId: out.prospectId,
      finalProspectId,
      returnTo: "marketing-accounts",
      returnParams: getReturnParams(),
    });
  } catch (e) {
    toast(e.message || "Could not open outreach");
  }
}
