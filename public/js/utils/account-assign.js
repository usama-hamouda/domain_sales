const { api, toast, esc } = window.AppAPI;

export function getAssignedAccountId(row) {
  return row.account_assignments?.[0]?.marketing_account_id || null;
}

export function renderAccountSelect(row, accounts, { mode = "prospect" } = {}) {
  const current = getAssignedAccountId(row);
  const attrs = mode === "final"
    ? `data-assign-mode="final" data-final-prospect-id="${row.id}"`
    : `data-assign-mode="prospect" data-prospect-id="${row.id}" data-final-prospect-id="${row.final_prospect_id || ""}"`;

  const options = (accounts || []).map((a) => {
    const full = a.exhausted ? " (FULL)" : "";
    return `<option value="${a.id}" ${String(a.id) === String(current) ? "selected" : ""}>${esc(a.name)}${full}</option>`;
  }).join("");

  return `
    <select class="account-assign-select" data-assign-account ${attrs} data-prev-value="${current || ""}" title="Assign marketing account">
      <option value="">—</option>
      ${options}
    </select>
  `;
}

export function showAssignmentWarnings(warnings) {
  if (!warnings?.length) return;
  toast(warnings.join(" "), 8000);
}

export async function handleAccountAssignChange(selectEl, accounts) {
  const accountId = selectEl.value ? Number(selectEl.value) : null;
  if (!accountId) {
    toast("Select a marketing account");
    const prev = selectEl.dataset.prevValue || "";
    selectEl.value = prev;
    return;
  }

  const mode = selectEl.dataset.assignMode;
  const prevValue = selectEl.dataset.prevValue || selectEl.value;
  selectEl.disabled = true;

  try {
    let out;
    if (mode === "final") {
      out = await api(`/api/final-prospects/${selectEl.dataset.finalProspectId}/assign-account`, {
        method: "POST",
        body: { marketingAccountId: accountId },
      });
    } else {
      out = await api(`/api/prospects/${selectEl.dataset.prospectId}/assign-account`, {
        method: "POST",
        body: { marketingAccountId: accountId },
      });
    }
    selectEl.dataset.prevValue = String(accountId);
    toast(`Assigned to ${accounts.find((a) => a.id === accountId)?.name || "account"}`);
    showAssignmentWarnings(out.warnings);
    return out;
  } catch (e) {
    selectEl.value = prevValue;
    toast(e.message || "Failed to assign account");
    return null;
  } finally {
    selectEl.disabled = false;
  }
}

export function bindAccountAssign(host, accounts, onAssigned) {
  host.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-assign-account]");
    if (!sel) return;
    const out = await handleAccountAssignChange(sel, accounts);
    if (out && onAssigned) onAssigned(sel, out);
  });
}

export async function loadMarketingAccounts() {
  return api("/api/marketing-accounts");
}
