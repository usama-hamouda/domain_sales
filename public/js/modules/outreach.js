const { api, toast, esc } = window.AppAPI;
import {
  CHANNEL_ORDER,
  buildChannelLaunch,
  openOutreachUrl,
  copyToClipboard,
  detectPlatform,
} from "../utils/outreach-channels.js";

const SLOT_LABELS = ["First Contact", "Follow-up 1", "Follow-up 2", "Follow-up 3", "Follow-up 4"];

const CHANNEL_LABELS = {
  gmail: "Gmail",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
};

const STATUS_LABELS = {
  sent: "Sent",
  scheduled: "Scheduled",
  due: "Due today",
  overdue: "Overdue",
  draft: "Draft",
};

let outreachContext = {};
let outreachState = {};

function buildAccountChannelMap(assignments) {
  const map = {};
  for (const a of assignments || []) {
    map[a.channel] = a;
  }
  return map;
}

function getTrackingSlot(tracking, slot) {
  return (tracking?.messages || []).find((m) => m.slot === slot) || null;
}

function findNextSendSlot(tracking, messages) {
  const msgs = tracking?.messages || [];
  if (msgs.length) {
    const overdue = msgs.filter((m) => m.status === "overdue").sort((a, b) => a.slot - b.slot);
    if (overdue.length) return overdue[0].slot;

    const due = msgs.filter((m) => m.status === "due").sort((a, b) => a.slot - b.slot);
    if (due.length) return due[0].slot;

    const unsent = msgs.filter((m) => m.status !== "sent").sort((a, b) => a.slot - b.slot);
    if (unsent.length) return unsent[0].slot;
  }

  const raw = (messages || []).filter((m) => m.status !== "sent").sort((a, b) => a.slot - b.slot);
  return raw.length ? raw[0].slot : null;
}

function scrollToSlot(slot) {
  if (slot === null || slot === undefined) return;
  requestAnimationFrame(() => {
    const el = document.querySelector(`.message-slot[data-slot="${slot}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

function renderChannelButtons(slot, accountMap) {
  return CHANNEL_ORDER.map((channel) => {
    const assignment = accountMap[channel];
    const label = CHANNEL_LABELS[channel];
    if (!assignment) {
      return `<button type="button" disabled title="Not configured on assigned marketing account">${label}</button>`;
    }
    const sender = assignment.account_identifier;
    return `<button type="button" data-channel="${channel}" data-slot="${slot}" title="Send via ${esc(label)} as ${esc(sender)}">${label}</button>`;
  }).join("");
}

export async function initOutreachModule(root, params = {}) {
  outreachContext = { ...params };
  const prospectId = params.prospectId;
  if (!prospectId) {
    root.innerHTML = `<div style="padding:24px;color:var(--text-dim)">No prospect selected.</div>`;
    return;
  }

  const data = await api(`/api/prospects/${prospectId}`);
  const finalProspectId = params.finalProspectId || data.final_prospect_id || null;
  let tracking = data.message_tracking;

  if (finalProspectId && !tracking) {
    try {
      tracking = await api(`/api/final-prospects/${finalProspectId}/message-tracking`);
    } catch {
      tracking = null;
    }
  }

  outreachState = {
    prospectId,
    finalProspectId,
    data,
    tracking,
    domain: data.campaign_domain?.domain || "",
    accountMap: buildAccountChannelMap(data.account_assignments),
    platform: detectPlatform(),
  };

  renderOutreachShell(root);
  renderMessages();
  scrollToSlot(findNextSendSlot(outreachState.tracking, outreachState.data.messages));
}

function renderOutreachShell(root) {
  const { data, domain, finalProspectId, accountMap } = outreachState;
  const backLabel = outreachContext.returnTo === "final-prospects"
    ? "← Final List"
    : outreachContext.returnTo === "marketing-accounts"
      ? "← Marketing Accounts"
      : "← Prospects";

  const assignments = data.account_assignments || [];
  const accountName = assignments[0]?.account_name;
  const accountId = assignments[0]?.marketing_account_id;

  const accountsHtml = assignments.length
    ? `<div class="card" style="margin-bottom:12px;padding:10px 14px">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
          Assigned marketing account${accountName ? `: <b>${esc(accountName)}</b>` : ""}${accountId ? ` <span style="opacity:0.75">(#${accountId})</span>` : ""}
          — channel buttons below use these sender identities
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px">
          ${assignments.map((a) => `
            <div style="padding:4px 8px;background:var(--bg-alt);border-radius:4px">
              <b>${esc(CHANNEL_LABELS[a.channel] || a.channel)}</b>: ${esc(a.account_identifier)}
            </div>
          `).join("")}
        </div>
        ${CHANNEL_ORDER.some((ch) => !accountMap[ch])
          ? `<div style="font-size:11px;color:var(--text-dim);margin-top:8px">Disabled channel buttons are not set up on this marketing account.</div>`
          : ""}
      </div>`
    : `<div class="card" style="margin-bottom:12px;padding:10px 14px;font-size:12px;color:var(--text-dim)">No marketing account assigned. Add this prospect to the final list to auto-assign an account.</div>`;

  const resetBtn = finalProspectId
    ? `<button id="btnResetStatus" class="warn" title="Clear sent status on all messages">Reset status</button>`
    : "";

  root.innerHTML = `
    <div class="main-panel" style="overflow-y:auto" id="outreachMainPanel">
      <div class="toolbar">
        <button id="btnBack">${backLabel}</button>
        <span class="toolbar-title">Outreach: ${esc(data.name || data.website || "Prospect")}</span>
        <span style="font-size:12px;color:var(--text-dim)">Domain: ${esc(domain)}</span>
        <div class="outreach-toolbar-actions">${resetBtn}</div>
      </div>
      <div id="outreachAccountsHost"></div>
      <div class="detail-panel" id="messageSlots"></div>
    </div>
  `;

  document.getElementById("outreachAccountsHost").innerHTML = accountsHtml;

  document.getElementById("btnBack").onclick = () => {
    const params = outreachContext;
    if (params.returnTo === "final-prospects" && params.returnParams) {
      window.AppRouter.navigate("final-prospects", params.returnParams);
    } else if (params.returnTo === "marketing-accounts") {
      window.AppRouter.navigate("marketing-accounts", params.returnParams || {});
    } else if (params.returnTo === "marketing" && params.returnParams?.campaignDomainId) {
      window.AppRouter.navigate("marketing", { campaignDomainId: params.returnParams.campaignDomainId });
    } else if (data.campaign_domain_id) {
      window.AppRouter.navigate("marketing", { campaignDomainId: data.campaign_domain_id });
    } else {
      window.AppRouter.navigate("campaigns");
    }
  };

  const resetStatusBtn = document.getElementById("btnResetStatus");
  if (resetStatusBtn) {
    resetStatusBtn.onclick = async () => {
      if (!confirm("Reset all message statuses to Draft? Sent dates will be cleared.")) return;
      try {
        outreachState.tracking = await api(
          `/api/final-prospects/${finalProspectId}/message-tracking/reset-status`,
          { method: "POST" },
        );
        await reloadProspectData();
        renderMessages();
        toast("Message statuses reset");
      } catch (e) {
        toast(e.message || "Failed to reset status");
      }
    };
  }
}

async function reloadProspectData() {
  const data = await api(`/api/prospects/${outreachState.prospectId}`);
  outreachState.data = data;
  outreachState.accountMap = buildAccountChannelMap(data.account_assignments);
  if (outreachState.finalProspectId) {
    outreachState.tracking = data.message_tracking
      || await api(`/api/final-prospects/${outreachState.finalProspectId}/message-tracking`);
  }
}

function renderMessages() {
  const { data, tracking, domain, accountMap, finalProspectId } = outreachState;
  const container = document.getElementById("messageSlots");
  const messages = data.messages || [];
  const nextSlot = findNextSendSlot(tracking, messages);

  container.innerHTML = SLOT_LABELS.map((label, slot) => {
    const msg = messages.find((m) => m.slot === slot) || { subject: "", body: "", status: "draft" };
    const track = getTrackingSlot(tracking, slot);
    const subject = msg.subject || `Interest in ${domain}`;
    const body = msg.body || defaultBody(domain, slot);
    const sent = msg.status === "sent";
    const derivedStatus = sent ? "sent" : (track?.status || "draft");
    const dueDate = track?.scheduled_date || "";
    const isNext = nextSlot === slot && !sent;

    const statusBadge = track || sent
      ? `<span class="msg-status ${esc(derivedStatus)}">${esc(STATUS_LABELS[derivedStatus] || derivedStatus)}</span>`
      : "";

    const dueDateHtml = dueDate
      ? `<span class="slot-due-date">Due: <b>${esc(dueDate)}</b></span>`
      : finalProspectId
        ? `<span class="slot-due-date" style="color:var(--text-dim)">Due: —</span>`
        : "";

    const markBtnClass = sent ? "warn sent-toggle is-sent" : "success sent-toggle";
    const markBtnLabel = sent ? "↩ Mark Unsent" : "✓ Mark Sent";

    return `
      <div class="card message-slot${isNext ? " active" : ""}" data-slot="${slot}">
        <div class="slot-header">
          <span class="slot-label">${label}</span>
          ${sent ? `<span class="sent-badge">Sent ${msg.sent_via || ""} ${msg.sent_at ? new Date(msg.sent_at).toLocaleDateString() : ""}</span>` : ""}
          <div class="channel-btns">
            ${renderChannelButtons(slot, accountMap)}
            <button type="button" class="${markBtnClass}" data-mark="${slot}" data-sent="${sent ? "1" : "0"}">${markBtnLabel}</button>
          </div>
        </div>
        <div class="slot-meta">
          ${statusBadge}
          ${dueDateHtml}
        </div>
        <input type="text" class="msg-subject" data-slot="${slot}" value="${esc(subject)}" placeholder="Subject">
        <textarea class="msg-body" data-slot="${slot}" placeholder="Message body">${esc(body)}</textarea>
        <button type="button" data-save="${slot}" style="margin-top:6px">Save Message</button>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-save]").forEach((btn) => {
    btn.onclick = () => saveMessage(data.id, Number(btn.dataset.save));
  });

  container.querySelectorAll("[data-mark]").forEach((btn) => {
    btn.onclick = async () => {
      const slot = Number(btn.dataset.mark);
      const isSent = btn.dataset.sent === "1";
      await saveMessage(data.id, slot, false);
      try {
        if (isSent) {
          await api(`/api/prospects/${data.id}/messages/${slot}/unsent`, { method: "POST" });
          toast("Marked as unsent");
        } else {
          await api(`/api/prospects/${data.id}/messages/${slot}/sent`, { method: "POST", body: { via: "manual" } });
          toast("Marked as sent");
        }
        await reloadProspectData();
        renderMessages();
      } catch (e) {
        toast(e.message || "Failed to update status");
      }
    };
  });

  container.querySelectorAll("[data-channel]").forEach((btn) => {
    btn.onclick = async () => {
      const slot = Number(btn.dataset.slot);
      await openChannel(btn.dataset.channel, data, slot, accountMap);
    };
  });
}

function getSlotContent(prospectId, slot) {
  const subj = document.querySelector(`.msg-subject[data-slot="${slot}"]`)?.value || "";
  const body = document.querySelector(`.msg-body[data-slot="${slot}"]`)?.value || "";
  return { subject: subj, body };
}

async function saveMessage(prospectId, slot, showToast = true) {
  const { subject, body } = getSlotContent(prospectId, slot);
  await api(`/api/prospects/${prospectId}/messages/${slot}`, {
    method: "PUT",
    body: { subject, body },
  });
  if (showToast) toast("Message saved");
}

function defaultBody(domain, slot) {
  if (slot === 0) {
    return `Hello,\n\nI own the domain name ${domain} and believe it could be a strong fit for your brand.\n\nWould you be open to a brief conversation about acquiring it?\n\nBest regards`;
  }
  return `Hello,\n\nFollowing up on my previous message regarding the domain ${domain}. I'd love to hear if this is of interest.\n\nBest regards`;
}

async function openChannel(channel, prospect, slot, accountMap) {
  const assignment = accountMap[channel];
  if (!assignment) {
    toast(`No ${CHANNEL_LABELS[channel] || channel} configured on the assigned marketing account.`);
    return;
  }

  const { subject, body } = getSlotContent(prospect.id, slot);
  const platform = detectPlatform();
  const launch = buildChannelLaunch(channel, {
    prospect,
    senderIdentifier: assignment.account_identifier,
    subject,
    body,
  }, platform);

  if (!launch.appUrl && !launch.webUrl) {
    toast(launch.hint);
    return;
  }

  // Open immediately while the tap gesture is still active (required on iOS for deep links)
  openOutreachUrl(launch.appUrl, launch.webUrl, platform);

  if (launch.needsClipboard) {
    const copied = await copyToClipboard(body);
    if (copied) {
      toast(`${launch.hint}. Message copied — paste when composing.`, 6000);
    } else {
      toast(launch.hint, 5000);
    }
  } else {
    toast(launch.hint, 4000);
  }
}
