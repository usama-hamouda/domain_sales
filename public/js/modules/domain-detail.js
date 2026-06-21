const { api, esc } = window.AppAPI;

export async function initDomainDetailModule(root, params = {}) {
  const id = params.campaignDomainId;
  if (!id) {
    root.innerHTML = `<div style="padding:24px;color:var(--text-dim)">No domain selected.</div>`;
    return;
  }

  const d = await api(`/api/campaign-domains/${id}`);
  const results = d.processing_results || [];

  const grouped = {};
  for (const r of results) {
    if (!grouped[r.step]) grouped[r.step] = [];
    grouped[r.step].push(r);
  }

  root.innerHTML = `
    <div class="main-panel" style="overflow-y:auto">
      <div class="toolbar">
        <button onclick="window.AppRouter.navigate('campaigns')">← Campaigns</button>
        <span class="toolbar-title">${esc(d.domain)}</span>
        <button class="primary" onclick="window.AppRouter.navigate('marketing',{campaignDomainId:${id}})">Marketing →</button>
      </div>
      <div class="detail-panel">
        <div class="card">
          <h4>Summary</h4>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;font-family:JetBrains Mono;font-size:12px">
            <div>G-Exact: ${d.google_exact || 0}</div>
            <div>G-Partial: ${d.google_partial || 0}</div>
            <div>LinkedIn: ${d.linkedin_exact || 0}</div>
            <div>Instagram: ${d.instagram_exact || 0}</div>
            <div>ZFBot: ${d.zfbot_count || 0}</div>
            <div>Crunchbase: ${d.crunchbase_exact || 0}</div>
          </div>
        </div>
        ${Object.entries(grouped).map(([step, items]) => `
          <div class="card">
            <h4>${esc(step)} (${items.length} results)</h4>
            <table class="data-table" style="width:100%">
              <thead><tr><th>Match</th><th>Domain</th><th>Title</th><th>URL</th></tr></thead>
              <tbody>
                ${items.map((r) => `
                  <tr>
                    <td>${esc(r.match_type)}</td>
                    <td>${esc(r.result_domain)}</td>
                    <td>${esc(r.title || "")}</td>
                    <td>${r.url ? `<a href="${esc(r.url)}" target="_blank">link</a>` : ""}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `).join("") || `<div class="card"><p style="color:var(--text-dim)">No processing results yet. Run processing from the Lists module.</p></div>`}
      </div>
    </div>
  `;
}
