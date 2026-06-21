# Domain Sales — deployment guide (Windows local + Ubuntu VPS)

This app is a **Node.js + SQLite** web UI with optional **Python/Chrome** processing. Use this guide to run it on your **Windows PC** (full workflow) and on an **Ubuntu VPS** (mobile outreach over **HTTP + IP**).

---

## 1. Deployment strategy

### Roles

| Environment | Best for | Runs |
|-------------|----------|------|
| **Windows (local)** | Domain import, Selenium processing, scraping, heavy work | Node + Python + Chrome |
| **Ubuntu VPS** | Phone/tablet outreach, marketing lists, final prospects | Node behind nginx |

### Recommended setup: one database, two access points

```
┌─────────────────────┐         scp DB               ┌─────────────────────┐
│  Windows PC         │  ─────────────────────────►  │  Ubuntu VPS         │
│  • Process domains  │      domain_sales.db         │  • nginx :8080      │
│  • Scrape contacts  │                              │  • Mobile outreach  │
│  localhost:3001     │                              │  http://VPS_IP:8080 │
└─────────────────────┘                              └─────────────────────┘
```

**Important:** SQLite is a **single file** (`backend/domain_sales.db`). Windows and VPS must **not** both write to different copies at the same time or data will diverge.

**Workflow:**

1. Work on **Windows** (processing, lists, campaigns).
2. Copy the **database** to the VPS before mobile use.
3. Open **`http://YOUR_VPS_IP:8080`** on your phone.
4. After mobile session, copy DB back to Windows if needed.

### IP only (no domain) — why port 8080?

You already run **other websites on nginx port 80**. Domain Sales listens on **port 8080** so it does not conflict:

**`http://203.0.113.50:8080`** ← replace with your real VPS IP

HTTPS with Let's Encrypt needs a domain name; skip it for now. HTTP over IP is fine for private outreach use.

### What NOT to run on a typical VPS

- Google Selenium processors (Chrome, captchas, ZFBot)
- Heavy Puppeteer scraping

Use the VPS for **marketing, final prospects, outreach, and account assignment**.

---

## 2. Prerequisites

### Windows

- [Node.js](https://nodejs.org/) 18+ LTS
- Python 3.10+ with `pip install -r python/requirements.txt`
- Google Chrome (for processors)

### Ubuntu VPS

- Ubuntu 22.04 or 24.04
- nginx (already installed)
- Node.js 18+:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 3. Upload code to the VPS

### Option A — Git

```powershell
# Windows — in project folder
git init
git add .
git commit -m "Initial domain-sales"
# push to private repo
```

```bash
# VPS
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/YOU/domain-sales.git
sudo chown -R $USER:$USER domain-sales
```

### Option B — SCP from Windows

```powershell
scp -r C:\Users\Admin\Desktop\domain-sales user@YOUR_VPS_IP:/var/www/
```

Do **not** upload `.env` or `domain_sales.db` to public repos.

---

## 4. Configure Ubuntu VPS (step by step)

Replace `YOUR_VPS_IP` everywhere with your real IP (e.g. `91.123.45.67`).

### Step 1 — Install Node dependencies

```bash
cd /var/www/domain-sales/backend
npm install --production
```

### Step 2 — Environment file

```bash
cd /var/www/domain-sales
cp .env.example .env
nano .env
```

```env
PORT=3001
HOST=127.0.0.1
NODE_ENV=production
```

Node binds to **localhost only**; nginx on **8080** is the public entry.

### Step 3 — Copy database from Windows

```powershell
scp C:\Users\Admin\Desktop\domain-sales\backend\domain_sales.db user@YOUR_VPS_IP:/var/www/domain-sales/backend/
```

### Step 4 — systemd service

```bash
sudo cp /var/www/domain-sales/deploy/domain-sales.service /etc/systemd/system/
sudo nano /etc/systemd/system/domain-sales.service
```

Fix `User`, `WorkingDirectory`, paths if needed.

```bash
sudo systemctl daemon-reload
sudo systemctl enable domain-sales
sudo systemctl start domain-sales
sudo systemctl status domain-sales
curl -s http://127.0.0.1:3001/api/health
```

### Step 5 — nginx (port 8080, IP access)

```bash
sudo cp /var/www/domain-sales/deploy/nginx-domain-sales.conf.example /etc/nginx/sites-available/domain-sales
sudo ln -sf /etc/nginx/sites-available/domain-sales /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

No `server_name` or domain edits required — config uses `listen 8080` and `server_name _`.

### Step 6 — Open firewall port 8080

```bash
# If using ufw:
sudo ufw allow 8080/tcp
sudo ufw status
```

Also open **8080** in your VPS provider panel (Hetzner, DigitalOcean, etc.) if it has a cloud firewall.

### Step 7 — Test from your phone

On the same Wi‑Fi or mobile data:

```
http://YOUR_VPS_IP:8080
```

Bookmark it on your phone for outreach.

---

## 5. Configure Windows (local)

```powershell
cd C:\Users\Admin\Desktop\domain-sales\backend
npm install

cd ..\python
pip install -r requirements.txt

copy ..\.env.example ..\.env
notepad ..\.env
```

```env
PORT=3001
HOST=0.0.0.0
ZFBOT_EMAIL=your@email.com
ZFBOT_PASSWORD=yourpassword

# Auto-push DB to VPS after every local change (see section 6)
REMOTE_DB_SYNC_ENABLED=1
REMOTE_SSH_HOST=YOUR_VPS_IP
REMOTE_SSH_USER=your_linux_user
REMOTE_DB_PATH=/var/www/domain-sales/backend/domain_sales.db
REMOTE_SSH_KEY_PATH=C:\Users\Admin\.ssh\id_rsa
```

Start:

```powershell
cd C:\Users\Admin\Desktop\domain-sales\backend
node server.js
```

Or double-click **`start.bat`**.

Open **http://localhost:3001**

---

## 6. Database sync (Windows ↔ VPS)

### Automatic push (recommended on Windows)

When `REMOTE_DB_SYNC_ENABLED=1` in your **Windows** `.env`, the app pushes `domain_sales.db` to the VPS after local changes:

- API saves (prospects, outreach, campaigns, etc.)
- Processing jobs finishing
- Any DB write (via file watcher)

Changes appear on the VPS within a few seconds (default debounce: 4s).

**One-time SSH setup (Windows PowerShell):**

```powershell
# Generate key if you don't have one
ssh-keygen -t ed25519

# Copy to VPS (enter VPS password once)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@YOUR_VPS_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**VPS — allow restart without password** (for sync to restart the app after upload):

```bash
sudo visudo
# Add line (replace user):
user ALL=(ALL) NOPASSWD: /bin/systemctl stop domain-sales, /bin/systemctl start domain-sales
```

**Check sync status:**

```powershell
curl http://localhost:3001/api/sync/status
```

**Manual push:**

```powershell
curl -X POST http://localhost:3001/api/sync/push
```

**Important rules:**

- Enable sync **only on Windows**, never on the VPS `.env`
- Do not edit data on **both** Windows and VPS at the same time — last push wins
- After using the app on your **phone (VPS)**, pull DB back to Windows (below)

### Manual push (if auto-sync is off)

```powershell
ssh user@YOUR_VPS_IP "sudo systemctl stop domain-sales"
scp C:\Users\Admin\Desktop\domain-sales\backend\domain_sales.db user@YOUR_VPS_IP:/var/www/domain-sales/backend/
ssh user@YOUR_VPS_IP "sudo systemctl start domain-sales"
```

### VPS → Windows (after mobile session)

```powershell
# Stop Windows app first (close start.bat)
scp user@YOUR_VPS_IP:/var/www/domain-sales/backend/domain_sales.db C:\Users\Admin\Desktop\domain-sales\backend\
```

---

## 7. Updating code

**VPS:**

```bash
cd /var/www/domain-sales
git pull
cd backend && npm install --production
sudo systemctl restart domain-sales
```

**Windows:** pull/copy files, `npm install`, restart `start.bat`.

---

## 8. Troubleshooting

| Problem | Fix |
|---------|-----|
| Cannot reach `http://IP:8080` | `sudo ufw allow 8080`; check cloud firewall; `curl http://127.0.0.1:8080` on VPS |
| `502 Bad Gateway` | `sudo systemctl status domain-sales`; Node must run on 3001 |
| Auto-sync fails on Windows | Test `ssh user@VPS_IP`; check `REMOTE_SSH_KEY_PATH`; see `/api/sync/status` `lastError` |
| Empty app | Copy `domain_sales.db` from Windows and restart service |
| Other site broke | Domain Sales uses **8080**, not 80 — should not affect existing sites |
| WhatsApp button empty | Fill **Phone (WhatsApp)** on the prospect |

```bash
# On VPS — quick checks
curl http://127.0.0.1:3001/api/health
curl -I http://127.0.0.1:8080
sudo journalctl -u domain-sales -f
```

---

## 9. Security (IP / HTTP)

- [ ] Node on `127.0.0.1:3001` only (not public)
- [ ] `chmod 600 /var/www/domain-sales/.env`
- [ ] Optional: nginx **basic auth** on port 8080 (recommended if IP is public)
- [ ] Add a domain + HTTPS later when ready (`certbot` needs a hostname)

### Optional: basic auth on :8080

```bash
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.domain-sales-htpasswd yourusername
```

Add inside the `server { }` block in nginx:

```nginx
auth_basic "Domain Sales";
auth_basic_user_file /etc/nginx/.domain-sales-htpasswd;
```

Then `sudo nginx -t && sudo systemctl reload nginx`.

---

## 10. Quick reference

| Task | Windows | VPS |
|------|---------|-----|
| Start | `start.bat` | `sudo systemctl start domain-sales` |
| Stop | Close terminal | `sudo systemctl stop domain-sales` |
| URL | http://localhost:3001 | **http://YOUR_VPS_IP:8080** |
| DB sync | Auto-push to VPS if `REMOTE_DB_SYNC_ENABLED=1` | Receives pushed DB from Windows |
| Database | `backend\domain_sales.db` | `/var/www/domain-sales/backend/domain_sales.db` |
| Logs | Console | `journalctl -u domain-sales -f` |

### Later: add a domain

When you have a hostname, point DNS to the VPS, switch nginx to `listen 80` + `server_name your.domain`, then run `sudo certbot --nginx -d your.domain`.
