# Deploying to a Windows Server

Step-by-step instructions for getting the SYNCAXIS Dashboard running permanently
on a Windows Server in the office LAN. Run these directly on that server
(RDP in, then use PowerShell or Command Prompt).

## 0. Prerequisites

- **Node.js LTS** (v18+). If not installed, download from https://nodejs.org
  — the Windows `.msi` installer, next-next-finish. Verify with:
  ```
  node --version
  ```
- **Network access** from this server to `192.168.3.9\SQLEXPRESS` — same LAN,
  or routed/firewalled to allow SQL Server's TCP port and UDP 1434 (SQL
  Browser, needed to resolve the named instance). If this server is on a
  different subnet/VLAN than machines that already connect fine, this is the
  step most likely to need IT involvement.

## 1. Get the code onto the server

**Option A — git clone** (repo is private, you'll need a GitHub personal
access token when prompted for a password):
```
git clone https://github.com/ashishpatelnx5/syncaxis_erp_dashboard.git
cd syncaxis_erp_dashboard\dashboard-app
```

**Option B — copy manually** (simpler if you don't want git on the server):
copy the whole `dashboard-app` folder over a network share, USB drive, or RDP
clipboard/file transfer to e.g. `C:\Apps\syncaxis-dashboard`, then `cd` into
it.

## 2. Install dependencies

```
npm ci
```
(`npm ci` instead of `npm install` — exact, reproducible install from
`package-lock.json`.)

## 3. Create `.env`

This file is intentionally excluded from git (it holds real credentials), so
it won't come with the clone — create it fresh. Copy `.env - Copy.example`
to `.env`, then edit `.env` in Notepad so it reads:

```
DB_SERVER=192.168.3.9
DB_INSTANCE=SQLEXPRESS
DB_DATABASE=SYNCAXIS
DB_USER=syncaxis_dashboard_ro
DB_PASSWORD=<the read-only password — ask Ashish if you don't have it>
PORT=3000

AUTH_USERNAME=syncaxis
AUTH_PASSWORD=<the shared dashboard login password — ask Ashish>
SESSION_SECRET=<a long random string — see below>
```

`AUTH_USERNAME`/`AUTH_PASSWORD` are the one shared login everyone uses to
open the dashboard (there are no individual accounts). `SESSION_SECRET`
signs the login cookie; generate a fresh one per deployment rather than
reusing the value from another `.env` — in PowerShell:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste the output as `SESSION_SECRET`. To force everyone to sign in again
later (e.g. right after changing `AUTH_PASSWORD`), regenerate this value and
restart the service — every existing browser session is invalidated at once.

## 4. Test it manually first

```
npm start
```
Open a browser **on the server itself** to http://localhost:3000 — it should
redirect to a login page. Sign in with the `AUTH_USERNAME`/`AUTH_PASSWORD`
from `.env`, then confirm the green "Connected" dot in the sidebar. This is
where you'll find out immediately if the network path to the DB works from
this machine. Press Ctrl+C in the terminal to stop it once confirmed.

## 5. Install it as a permanent Windows Service (NSSM)

`npm start` only runs in the foreground — closing the window kills the app.
For an always-on service that survives reboots and restarts itself if it
crashes, use NSSM (Non-Sucking Service Manager):

1. Download NSSM from https://nssm.cc/download, extract it, and note the
   path to `nssm.exe` (use the `win64` folder on a 64-bit server).
2. Find the full path to `node.exe` (usually
   `C:\Program Files\nodejs\node.exe`) and the full path to this app's
   `server.js`.
3. Run (adjust paths to match your setup):
   ```
   nssm install SyncaxisDashboard "C:\Program Files\nodejs\node.exe" "C:\Apps\syncaxis-dashboard\server.js"
   nssm set SyncaxisDashboard AppDirectory "C:\Apps\syncaxis-dashboard"
   nssm start SyncaxisDashboard
   ```
4. Check it's running:
   ```
   nssm status SyncaxisDashboard
   ```
   or open Windows Services (`services.msc`) and look for "SyncaxisDashboard".

To stop/restart later:
```
nssm restart SyncaxisDashboard
nssm stop SyncaxisDashboard
```

## 6. Let others on the office LAN reach it

If people need to open the dashboard from their own PCs (not just the
server), open the firewall port:
```
netsh advfirewall firewall add rule name="Syncaxis Dashboard" dir=in action=allow protocol=TCP localport=3000
```
Then anyone on the LAN can browse to `http://<server-hostname-or-ip>:3000`.

## 7. Updating later

When the code changes (new commits pushed to GitHub):
```
cd C:\Apps\syncaxis-dashboard
git pull
npm ci
nssm restart SyncaxisDashboard
```

## Troubleshooting

- **Red "DB connection failed" dot**: check the terminal/service log for the
  exact error. "Login failed" = wrong password in `.env`. A timeout =
  network/firewall path to `192.168.3.9` is blocked, or SQL Server Browser
  isn't running on the DB machine.
- **Port 3000 already in use**: change `PORT=` in `.env` to something else
  (e.g. `3001`) and re-run `nssm set SyncaxisDashboard AppParameters ...` or
  just restart after editing `.env` (the app reads it fresh on every start).
- **`npm ci` fails**: make sure `package-lock.json` came across with the
  clone/copy — it must be present alongside `package.json`.
- **Login page rejects the correct username/password**: `AUTH_USERNAME`/
  `AUTH_PASSWORD` in `.env` don't match what's being typed — check for stray
  whitespace or quotes if you pasted them. The app reads `.env` fresh on
  every start, so a fix just needs a restart, not a rebuild.
- **`express-session deprecated req.secret` warning in the log**:
  `SESSION_SECRET` is missing or empty in `.env`. The app still runs, but
  sessions are signed insecurely — set a real value (see step 3) and
  restart.
- **Everyone gets signed out at once, unprompted**: expected after a service
  restart (e.g. `nssm restart`, a reboot, or a redeploy) — sessions live in
  the server's memory, not a database, so restarting the process always
  clears them. This is also what happens deliberately if you rotate
  `SESSION_SECRET`.
