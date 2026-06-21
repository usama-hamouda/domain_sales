const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { db, DB_PATH } = require("../db");

const DEBOUNCE_MS = Number(process.env.REMOTE_DB_SYNC_DEBOUNCE_MS || 4000);

let debounceTimer = null;
let syncing = false;
let watcherStarted = false;
let lastSyncAt = null;
let lastError = null;
let pendingSync = false;

function isEnabled() {
  return process.env.REMOTE_DB_SYNC_ENABLED === "1"
    && process.env.REMOTE_SSH_HOST
    && process.env.REMOTE_SSH_USER;
}

function getConfig() {
  return {
    enabled: isEnabled(),
    host: process.env.REMOTE_SSH_HOST || null,
    user: process.env.REMOTE_SSH_USER || null,
    remotePath: process.env.REMOTE_DB_PATH || "/var/www/domain-sales/backend/domain_sales.db",
    manageService: process.env.REMOTE_SERVICE_MANAGE !== "0",
    debounceMs: DEBOUNCE_MS,
  };
}

function getStatus() {
  return {
    ...getConfig(),
    syncing,
    pendingSync,
    lastSyncAt,
    lastError,
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function sshTarget() {
  const { REMOTE_SSH_USER, REMOTE_SSH_HOST } = process.env;
  return `${REMOTE_SSH_USER}@${REMOTE_SSH_HOST}`;
}

function sshArgs(remoteCommand) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
  ];
  const keyPath = process.env.REMOTE_SSH_KEY_PATH;
  if (keyPath) args.push("-i", keyPath);
  args.push(sshTarget(), remoteCommand);
  return args;
}

function scpArgs(localPath, remotePath) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
  ];
  const keyPath = process.env.REMOTE_SSH_KEY_PATH;
  if (keyPath) args.push("-i", keyPath);
  args.push(localPath, `${sshTarget()}:${remotePath}`);
  return args;
}

async function runSsh(command) {
  await runCommand("ssh", sshArgs(command));
}

async function runScp(localPath, remotePath) {
  await runCommand("scp", scpArgs(localPath, remotePath));
}

function checkpointDatabase() {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

async function syncNow() {
  if (!isEnabled()) {
    return { ok: false, error: "Remote DB sync is not configured" };
  }
  if (syncing) {
    pendingSync = true;
    return { ok: true, queued: true };
  }

  syncing = true;
  pendingSync = false;
  lastError = null;

  const remotePath = process.env.REMOTE_DB_PATH || "/var/www/domain-sales/backend/domain_sales.db";
  const manageService = process.env.REMOTE_SERVICE_MANAGE !== "0";

  try {
    checkpointDatabase();

    if (manageService) {
      await runSsh("sudo systemctl stop domain-sales");
    }

    await runScp(DB_PATH, remotePath);

    if (manageService) {
      await runSsh("sudo systemctl start domain-sales");
    }

    lastSyncAt = new Date().toISOString();
    console.log(`[remote-db-sync] Pushed database to ${sshTarget()}:${remotePath}`);
    return { ok: true, lastSyncAt };
  } catch (err) {
    lastError = err.message;
    console.error("[remote-db-sync]", err.message);
    if (manageService) {
      try {
        await runSsh("sudo systemctl start domain-sales");
      } catch {
        // Best effort — remote may still be stopped.
      }
    }
    return { ok: false, error: err.message };
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      setTimeout(() => { syncNow().catch(() => {}); }, 500);
    }
  }
}

function scheduleSyncAfterWrite() {
  if (!isEnabled()) return;
  pendingSync = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    syncNow().catch(() => {});
  }, DEBOUNCE_MS);
}

function watchDatabaseFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    fs.watch(filePath, { persistent: false }, () => {
      scheduleSyncAfterWrite();
    });
  } catch (err) {
    console.warn(`[remote-db-sync] Could not watch ${filePath}:`, err.message);
  }
}

function startWatcher() {
  if (!isEnabled() || watcherStarted) return;
  watcherStarted = true;
  watchDatabaseFile(DB_PATH);
  watchDatabaseFile(`${DB_PATH}-wal`);
  console.log(`[remote-db-sync] Enabled → ${sshTarget()} (debounce ${DEBOUNCE_MS}ms)`);
}

function middleware() {
  return (req, res, next) => {
    if (!isEnabled()) return next();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (req.path.startsWith("/api/sync")) return next();

    res.on("finish", () => {
      if (res.statusCode < 400) scheduleSyncAfterWrite();
    });
    next();
  };
}

module.exports = {
  isEnabled,
  getStatus,
  syncNow,
  scheduleSyncAfterWrite,
  startWatcher,
  middleware,
};
