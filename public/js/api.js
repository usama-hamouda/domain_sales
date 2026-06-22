// const API = "/domsales";
const API = (() => {
  const script = document.currentScript;
  if (script && script.src) {
    return new URL(script.src).pathname.replace(/\/js\/api\.js$/, "");
  }
  return "";
})();

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

window.AppAPI = { api, toast, today, esc };
