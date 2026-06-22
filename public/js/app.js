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
  setupMobileSidebar();
}

function setupMobileSidebar() {
  const appBody = document.querySelector(".app-body");
  if (!appBody) return;

  const sidebar = appBody.querySelector(".sidebar");
  if (!sidebar) {
    appBody.classList.remove("sidebar-open");
    return;
  }

  appBody.classList.remove("sidebar-open");

  let toggle = appBody.querySelector(".sidebar-mobile-toggle");
  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sidebar-mobile-toggle";
    toggle.setAttribute("aria-label", "Open side panel");
    appBody.insertBefore(toggle, sidebar);

    let backdrop = appBody.querySelector(".sidebar-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "sidebar-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      appBody.appendChild(backdrop);
      backdrop.onclick = () => appBody.classList.remove("sidebar-open");
    }

    toggle.onclick = () => appBody.classList.toggle("sidebar-open");
  }

  const header = sidebar.querySelector(".sidebar-header span");
  toggle.textContent = `☰ ${header ? header.textContent.trim() : "Menu"}`;

  sidebar.querySelectorAll(".sidebar-item").forEach((item) => {
    if (item._mobileCloseBound) return;
    item.addEventListener("click", () => appBody.classList.remove("sidebar-open"));
    item._mobileCloseBound = true;
  });
}

function renderNav() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.module === currentModule);
  });
  document.getElementById("topNav")?.classList.remove("nav-open");
}

function init() {
  const nav = document.getElementById("topNav");
  const visibleModules = Object.entries(MODULES).filter(([, m]) => !m.hidden);

  nav.innerHTML =
    `<button type="button" class="nav-menu-btn" id="navMenuBtn" aria-label="Open navigation menu">☰</button>` +
    `<div class="logo">Domain Sales</div>` +
    `<div class="nav-tabs-wrap" id="navTabsWrap">` +
    visibleModules
      .map(([key, m]) => `<div class="nav-tab ${key === currentModule ? "active" : ""}" data-module="${key}">${m.label}</div>`)
      .join("") +
    `</div>` +
    `<span class="proc-status" id="procStatus"></span>`;

  document.getElementById("navMenuBtn").onclick = () => nav.classList.toggle("nav-open");

  nav.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.onclick = () => navigate(tab.dataset.module);
  });

  const hash = location.hash.slice(1);
  if (hash && MODULES[hash]) currentModule = hash;

  window.AppRouter = { navigate };
  renderModule();
}

document.addEventListener("DOMContentLoaded", init);
