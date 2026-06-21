import { initListsModule, cleanupListsModule } from "./modules/lists.js";
import { initCampaignsModule } from "./modules/campaigns.js";
import { initMarketingModule } from "./modules/marketing.js";
import { initOutreachModule } from "./modules/outreach.js";
import { initDomainDetailModule } from "./modules/domain-detail.js";
import { initFinalProspectsModule } from "./modules/final-prospects.js";
import { initMarketingAccountsModule } from "./modules/marketing-accounts.js";

const MODULES = {
  lists: { label: "Domain Lists", init: initListsModule },
  campaigns: { label: "Campaigns", init: initCampaignsModule },
  "marketing-accounts": { label: "Marketing Accounts", init: initMarketingAccountsModule },
  marketing: { label: "Marketing", init: initMarketingModule, hidden: true },
  outreach: { label: "Outreach", init: initOutreachModule, hidden: true },
  "domain-detail": { label: "Domain Detail", init: initDomainDetailModule, hidden: true },
  "final-prospects": { label: "Final Prospects", init: initFinalProspectsModule, hidden: true },
};

let currentModule = "lists";
let currentParams = {};

function navigate(module, params = {}) {
  if (currentModule === "lists" && module !== "lists") cleanupListsModule();
  currentModule = module;
  currentParams = params;
  renderNav();
  renderModule();
  history.replaceState({ module, params }, "", `#${module}`);
}

async function renderModule() {
  const root = document.getElementById("moduleRoot");
  const mod = MODULES[currentModule];
  if (!mod) return;
  root.innerHTML = `<div style="padding:20px;color:var(--text-dim)">Loading…</div>`;
  await mod.init(root, currentParams);
}

function renderNav() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.module === currentModule);
  });
}

function init() {
  const nav = document.getElementById("topNav");
  nav.innerHTML = `<div class="logo">Domain Sales</div>` +
    Object.entries(MODULES)
      .filter(([, m]) => !m.hidden)
      .map(([key, m]) => `<div class="nav-tab ${key === currentModule ? "active" : ""}" data-module="${key}">${m.label}</div>`)
      .join("") +
    `<span class="proc-status" id="procStatus"></span>`;

  nav.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.onclick = () => navigate(tab.dataset.module);
  });

  const hash = location.hash.slice(1);
  if (hash && MODULES[hash]) currentModule = hash;

  window.AppRouter = { navigate };
  renderModule();
}

document.addEventListener("DOMContentLoaded", init);
