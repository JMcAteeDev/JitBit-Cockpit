# JitBit Cockpit: Ticket Triage Dashboard

A zero-dependency, local AI-powered triage dashboard for Windows. Pulls assigned helpdesk tickets from the JitBit REST API, triages them with a free AI model via OpenRouter, and renders everything in a self-contained HTML dashboard.

---

## File Structure

| File | Purpose |
|---|---|
| `dashboard.html` | The dashboard. Double-click to open. Self-contained — no server needed. |
| `triage_data.json` | Local ticket cache. Preserves AI triage between syncs. |
| `refresh_from_api.ps1` | Main sync script. Pulls JitBit tickets, calls AI, rebuilds the dashboard. |
| `setup_scheduler.ps1` | One-time setup to register the hourly Windows Task Scheduler job. |
| `.env` | Credentials and API keys. Never committed. |

---

## Setup

### 1. Configure `.env`

```env
JITBIT_TENANT_URL=https://yourdomain.jitbit.com/helpdesk
JITBIT_USERNAME=your_email@domain.com
JITBIT_PASSWORD=your_jitbit_api_token
OPENROUTER_API_KEY=your_openrouter_api_key
```

### 2. Register the Hourly Auto-Refresh (one-time, run as Administrator)

```powershell
powershell -ExecutionPolicy Bypass -File "setup_scheduler.ps1"
```

This registers a Windows Task Scheduler job that runs `refresh_from_api.ps1` every hour from **6 AM to 6 PM, Monday through Friday**.

### 3. Manual Sync (anytime)

```powershell
powershell -ExecutionPolicy Bypass -File "refresh_from_api.ps1"
```

---

## How It Works

1. **JitBit pull** — The script authenticates to JitBit with a Bearer token and fetches all tickets assigned to you, including comment threads.
2. **AI triage** — New tickets and tickets with new replies since last sync are sent to OpenRouter (`openrouter/free`) for analysis. The model returns a priority, one-sentence justification, recommended actions, and a draft reply addressed to the submitter.
3. **Heuristic fallback** — If the OpenRouter call fails (rate limit, network), keyword heuristics provide a basic triage so the dashboard is never empty.
4. **Preservation** — Tickets with no new activity keep their existing AI triage untouched.
5. **Dashboard rebuild** — The script injects the updated JSON directly into `dashboard.html` using index-based string replacement (no regex, immune to `$` escaping bugs).

---

## AI Triage Priority Scale

| Priority | When it applies |
|---|---|
| **Critical** | IEP/special ed accommodations, safety issues, full class outage |
| **High** | Broken hardware, multiple users affected, time-sensitive instructional impact |
| **Medium** | Single user inconvenienced, workaround exists |
| **Low** | Deferred projects, enhancements, scheduled maintenance |

---

## Dashboard Features

- **KPI cards** — backlog count, urgent items, stale alerts
- **Live search** — filter tickets by any text
- **Location & priority filters** — one-click pills for BPS, BIS, BHS, Critical, High, etc.
- **Ticket detail drawer** — full conversation thread, AI justification, resolution checklist, draft response with copy button

---

## Notes

- The dashboard runs on the `file:///` protocol. No web server, no CORS issues.
- JitBit credentials never leave your machine. OpenRouter receives only ticket text (subject, body, comments, submitter name).
- On first run, all tickets are triaged sequentially with a 10-second gap between API calls to respect OpenRouter's free-tier rate limits. Subsequent runs only call the AI for tickets with new replies, so they complete quickly.
