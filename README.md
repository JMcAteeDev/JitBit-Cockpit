# JitBit Cockpit

A local AI-powered triage dashboard for JitBit helpdesk. It pulls your assigned tickets, uses a free AI model to prioritize them, and displays everything in a dashboard you open like any other file — no web server, no installation required.

---

## What You'll Need Before Starting

- **A JitBit account** with tickets assigned to you
- **A free OpenRouter account** — this is what powers the AI triage ([openrouter.ai](https://openrouter.ai))
- **Windows** — the sync script is PowerShell, which is built into Windows 10 and 11

That's it. No programming experience required.

---

## Step 1 — Download the Files

Click the green **Code** button on this GitHub page and choose **Download ZIP**. Extract the folder somewhere easy to find, like your Desktop or Documents.

You should see these files inside:

| File | What it does |
|---|---|
| `dashboard.html` | The dashboard -- double-click this to open it |
| `refresh_from_api.ps1` | The sync script -- run this to pull your tickets |
| `setup_scheduler.ps1` | Optional -- sets up automatic hourly syncing |
| `create_shortcut.ps1` | Optional -- creates a Desktop shortcut with a custom logo |
| `logo.png` | The app icon logo for the shortcut |
| `.env` | Your credentials -- **you create this in Step 2** |

---

## Step 2 — Create Your `.env` File

This file holds your credentials. It never leaves your computer.

An `example.env` file is included in this folder — rename it to `.env` and fill in your own values. Or create a new text file named exactly `.env` (no `.txt` extension) and paste in the following:

```
JITBIT_TENANT_URL=https://yourcompany.jitbit.com/helpdesk
JITBIT_USERNAME=you@yourcompany.com
JITBIT_PASSWORD=your_jitbit_api_token
OPENROUTER_API_KEY=sk-or-...
LOCATIONS=HQ:Headquarters,WH:Warehouse,RMT:Remote
```

### Where to find each value

**JITBIT_TENANT_URL**
This is the web address you use to log into JitBit, up to and including `/helpdesk`.
Example: `https://acme.jitbit.com/helpdesk`

**JITBIT_USERNAME**
The email address you use to log into JitBit.

**JITBIT_PASSWORD**
JitBit supports API token authentication. To get your token:
1. Log into JitBit
2. Click your name in the top-right corner
3. Go to **Profile** → **API Token**
4. Copy the token and paste it here

> If you can't find an API token, you can use your regular JitBit password instead. The API token is preferred because it's safer.

**OPENROUTER_API_KEY**
1. Go to [openrouter.ai](https://openrouter.ai) and create a free account
2. Click your profile → **API Keys**
3. Create a new key and paste it here

The free tier is enough for normal use. The dashboard processes each ticket with a short delay to stay within free-tier rate limits.

**LOCATIONS**
A comma-separated list of your physical locations. Each entry is a short code, a colon, then the full name.

```
LOCATIONS=HQ:Headquarters,WH:Warehouse,RMT:Remote
```

The short code (e.g. `HQ`) is what appears on ticket cards. The sync script looks for this code in ticket subjects and descriptions to automatically assign a location. You can have as many or as few locations as you like. If you only work in one building, you can leave this line out.

> **Tip:** Keep short codes brief (2–4 characters) and make sure they actually appear in your ticket text. If your building is called "Main Office" but nobody ever writes "MO" in tickets, the auto-detection won't fire — and that's fine, you can set location manually in the dashboard.

---

## Step 3 — Run Your First Sync

Right-click `refresh_from_api.ps1` and choose **Run with PowerShell**.

> If you see a security warning, click **Open** or **Run anyway**. Windows flags any downloaded script the first time. Alternatively, open PowerShell manually and run:
> ```
> powershell -ExecutionPolicy Bypass -File "refresh_from_api.ps1"
> ```

The script will:
1. Pull all tickets currently assigned to you from JitBit
2. Send new tickets to the AI for triage (priority, justification, suggested actions, draft reply)
3. Save everything locally and update the dashboard

**The first run takes a few minutes** if you have many tickets, because the AI processes them one at a time with a short pause between each. After the first run, only tickets with new replies get re-triaged, so subsequent syncs are fast.

---

## Step 4 — Open the Dashboard

Double-click `dashboard.html`. It opens in your default browser.

You'll see your tickets organized by priority with AI-generated triage notes. Click any ticket to see the full thread, recommended actions, and a draft reply you can copy.

---

## Step 5 (Optional) — Set Up Automatic Syncing

To have the dashboard update itself every hour while you're at work:

1. Right-click `setup_scheduler.ps1`
2. Choose **Run as Administrator** (this is required to create scheduled tasks)

This registers a Windows Task Scheduler job that runs the sync script every hour from **6 AM to 6 PM, Monday through Friday**. You don't need to do anything after that — the dashboard will always be fresh when you open it.

To sync manually at any time, just run `refresh_from_api.ps1` again.

---

## Step 6 (Optional) -- Create a Desktop Shortcut

To create a quick-access shortcut directly on your Desktop with a custom app icon:

1. Right-click `create_shortcut.ps1`
2. Choose **Run with PowerShell**

This will automatically:
* Generate a Windows-compatible icon file (`logo.ico`) from `logo.png`
* Create a shortcut named **JitBit Cockpit** on your Desktop pointing to your local `dashboard.html` using the custom icon.

---

## Setting Location Manually on a Ticket

If the AI couldn't detect a ticket's location automatically, you can set it yourself:

1. Click the ticket in the dashboard
2. In the **AI Triage Analysis** panel on the right, find the **Location** field
3. Click the dropdown and choose the correct location

This override is saved in your browser and persists across syncs.

---

## Troubleshooting

**"The dashboard is empty after running the script"**
Open `triage_data.js` in a text editor and check it has data in it. If it's empty or missing, re-run the script and look for red error messages in the PowerShell window.

**"I get a login error when running the script"**
Double-check your `JITBIT_TENANT_URL` — it should end with `/helpdesk` and have no trailing slash after that. Also verify your API token is correct in JitBit's profile page.

**"The AI triage isn't running / tickets say 'Automatically triaged'"**
This means the OpenRouter key is missing or incorrect. Check your `.env` file and make sure `OPENROUTER_API_KEY` is set. The heuristic fallback will still assign a basic priority.

**"Location pills aren't showing in the dashboard"**
Run the sync script once after adding `LOCATIONS` to your `.env`. The locations are injected into the dashboard data file during each sync.

**"I see a security warning when opening the PowerShell script"**
This is normal for downloaded scripts on Windows. Right-click → Properties → check **Unblock** at the bottom, then try running again. Or use the `ExecutionPolicy Bypass` command shown in Step 3.

---

## Repository Branches

This repository uses a two-branch workflow:
- **`main` (Stable)**: Contains stable, tested releases. Do not commit directly to this branch for feature development.
- **`dev` (Development)**: The branch where new features, updates, and bug fixes are developed and tested before merging into `main`.

To switch between branches:
* To work on new features: `git checkout dev`
* To switch back to stable: `git checkout main`

---

## Privacy

- Your JitBit credentials never leave your machine
- Only ticket text (subject, description, comments, submitter name) is sent to OpenRouter for AI analysis
- All data is stored locally in `triage_data.json` and `triage_data.js`
