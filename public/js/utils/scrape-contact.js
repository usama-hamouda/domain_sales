const { toast } = window.AppAPI;

export function ensureScrapeModal() {
  if (document.getElementById("scrapeProgressModal")) return;
  const el = document.createElement("div");
  el.id = "scrapeProgressModal";
  el.className = "modal-overlay hidden";
  el.innerHTML = `
    <div class="modal scrape-progress-modal">
      <h3>Contact Scrape Progress</h3>
      <p class="scrape-progress-hint">Visible Chrome may open — watch the browser window for live navigation.</p>
      <div id="scrapeProgressBar" class="scrape-progress-bar"><div id="scrapeProgressFill" class="scrape-progress-fill"></div></div>
      <div id="scrapeLog" class="scrape-log"></div>
      <div class="modal-actions">
        <button type="button" id="btnScrapeClose" disabled>Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  document.getElementById("btnScrapeClose").onclick = () => el.classList.add("hidden");
}

function appendScrapeLog(message, phase = "") {
  const logEl = document.getElementById("scrapeLog");
  if (!logEl) return;
  const line = document.createElement("div");
  line.className = `scrape-log-line${phase ? ` phase-${phase}` : ""}`;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setScrapeProgress(pct) {
  const fill = document.getElementById("scrapeProgressFill");
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

/**
 * @param {{ url: string, prospectId?: number, finalProspectId?: number, onComplete?: () => void | Promise<void> }} opts
 */
export async function scrapeContactWithProgress({ url, prospectId, finalProspectId, onComplete }) {
  ensureScrapeModal();
  const modal = document.getElementById("scrapeProgressModal");
  const logEl = document.getElementById("scrapeLog");
  const closeBtn = document.getElementById("btnScrapeClose");
  logEl.innerHTML = "";
  setScrapeProgress(5);
  closeBtn.disabled = true;
  modal.classList.remove("hidden");

  let donePayload = null;
  let errorMsg = null;
  let buffer = "";

  try {
    const body = { url, visible: true };
    if (prospectId) body.prospectId = prospectId;
    if (finalProspectId) body.finalProspectId = finalProspectId;

    const res = await fetch("/api/processing/scrape-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Scrape request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (evt.type === "progress") {
          appendScrapeLog(evt.message, evt.phase || "");
          if (evt.phase === "http") setScrapeProgress(35);
          if (evt.phase === "selenium") setScrapeProgress(65);
          if (evt.phase === "save") setScrapeProgress(90);
        } else if (evt.type === "done") {
          donePayload = evt;
          setScrapeProgress(100);
          const fields = (evt.enriched || []).join(", ") || "none";
          appendScrapeLog(`Done — enriched: ${fields}`, "done");
        } else if (evt.type === "error") {
          errorMsg = evt.error || "Scrape failed";
          appendScrapeLog(errorMsg, "error");
        }
      }
    }
  } catch (e) {
    errorMsg = e.message || "Scrape failed";
    appendScrapeLog(errorMsg, "error");
  }

  closeBtn.disabled = false;

  if (errorMsg) {
    toast(errorMsg);
    return;
  }

  const count = donePayload?.fields_found ?? 0;
  toast(count ? `Scrape complete — ${count} field(s) enriched` : "Scrape complete — no new contacts found");
  if (onComplete) await onComplete();
}
