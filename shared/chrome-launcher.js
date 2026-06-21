/**
 * Shared Chrome remote-debug launcher (used by Node backend).
 * Python processors connect to the same debug port.
 */

const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CHROME_PORT = Number(process.env.CHROME_DEBUG_PORT || 9223);
const CHROME_USER_DATA = process.env.CHROME_USER_DATA || "C:\\ChromeDebug";
const CHROME_PROFILE = process.env.CHROME_PROFILE || "Default";
const CHROME_EXE = process.env.CHROME_EXE ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let _chromeProc = null;
let _chromePid = null;

function isChromeDebugging(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 2500 },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve({ running: true, wsUrl: j.webSocketDebuggerUrl || null });
          } catch {
            resolve({ running: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ running: false }));
    req.on("timeout", () => { req.destroy(); resolve({ running: false }); });
  });
}

function findChromePids() {
  try {
    const out = execSync(
      `wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`,
      { timeout: 5000, encoding: "utf8" }
    );
    const pids = [];
    for (const line of out.split("\n")) {
      if (line.includes(`--remote-debugging-port=${CHROME_PORT}`)) {
        const m = line.match(/,(\d+)\s*$/);
        if (m) pids.push(Number(m[1]));
      }
    }
    return pids;
  } catch {
    return [];
  }
}

async function launchChrome() {
  const profilePath = path.join(CHROME_USER_DATA, CHROME_PROFILE);
  fs.mkdirSync(profilePath, { recursive: true });
  const args = [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${CHROME_USER_DATA}`,
    `--profile-directory=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=ChromeWhatsNew,SignInPromo,SyncPromo,ProfilePicker",
  ];

  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error(`Chrome not found at: ${CHROME_EXE}. Set CHROME_EXE env var.`);
  }

  _chromeProc = spawn(CHROME_EXE, args, { detached: false, stdio: "ignore", windowsHide: false });
  _chromePid = _chromeProc.pid;

  _chromeProc.on("exit", () => {
    _chromeProc = null;
    _chromePid = null;
  });

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const check = await isChromeDebugging(CHROME_PORT);
    if (check.running) return _chromePid;
  }
  throw new Error(`Chrome debug port ${CHROME_PORT} not available after launch`);
}

async function ensureChrome() {
  const check = await isChromeDebugging(CHROME_PORT);
  if (check.running) {
    const pids = findChromePids();
    _chromePid = pids[0] || null;
    return { launched: false, pid: _chromePid, port: CHROME_PORT };
  }
  const pid = await launchChrome();
  return { launched: true, pid, port: CHROME_PORT };
}

module.exports = { ensureChrome, isChromeDebugging, CHROME_PORT };
