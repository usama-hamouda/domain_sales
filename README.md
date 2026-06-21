# Domain Sales Platform

A full-stack app for filtering, processing, and marketing expired domains scraped from [expireddomains.net](https://expireddomains.net).

Built from the existing `domains-tools.html` / `domain-tool-backend` project.

## Modules

1. **Domain Lists** — Import CSV/HTML, filter & select domains, run processing pipeline, save to campaigns
2. **Campaigns** — View curated domain shortlists with processing metrics
3. **Marketing** — Per-domain prospect list with contact scraping
4. **Outreach** — 5-message sequence (1 contact + 4 follow-ups) with Gmail/WhatsApp/LinkedIn/Instagram/Facebook prefill

## Processing Pipeline (Python Selenium)

Each domain is processed through these steps (modular Python files in `python/processors/`):

| Step | Description |
|------|-------------|
| `google_serp` | Google search for brand words, 10 pages, grouped by match degree |
| `linkedin` | `site:linkedin.com/company` search, 3 pages |
| `instagram` | `site:instagram.com` search, 3 pages |
| `zfbot` | Related domains via zfbot.com (requires credentials) |
| `crunchbase` | `site:crunchbase.com` search, 3 pages |

Chrome runs in **remote debug mode** (port 9223) to reduce bot detection — same approach as the original app.

## Setup

### 1. Node backend

```bash
cd domain-sales/backend
npm install
npm start
```

App runs at **http://localhost:3001**

See **[DEPLOY.md](DEPLOY.md)** for Windows + Ubuntu VPS deployment (nginx, mobile access, database sync).

### 2. Python processors

```bash
cd domain-sales/python
pip install -r requirements.txt
```

Set environment variables (optional):

```bash
set ZFBOT_EMAIL=your@email.com
set ZFBOT_PASSWORD=yourpassword
set CHROME_DEBUG_PORT=9223
set PYTHON_EXE=python
```

### 3. Chrome debug mode

Chrome is auto-launched on first processing run. Or start manually:

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir=C:\ChromeDebug
```

## Usage

1. **Import** — Paste ExpiredDomains HTML, upload CSV, or load a historical list from the sidebar
2. **Filter** — Sort columns, rearrange by dragging headers, select rows
3. **Process** — Click ▶ Process (all) or ▶ Selected; pause/resume/stop anytime
4. **Campaign** — Select domains → → Campaign → create or pick existing
5. **Market** — Open campaign → 📣 icon → manage prospects → scrape contacts
6. **Outreach** — Click prospect → compose 5 messages → open Gmail/WhatsApp/etc.

## Database

SQLite file: `domain-sales/backend/domain_sales.db`

Tables: `domain_lists`, `domain_list_items`, `campaigns`, `campaign_domains`, `processing_results`, `processing_jobs`, `prospects`, `outreach_messages`

## Project Structure

```
domain-sales/
  backend/          Express API + SQLite
  python/           Selenium processors (modular)
  public/           Frontend SPA
  shared/           Chrome launcher (Node)
```
