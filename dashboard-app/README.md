# SYNCAXIS Management Dashboard

A local web app that connects to your SYNCAXIS SQL Server database and shows
management KPIs across five areas: Sales & Revenue, Purchase & Vendor spend,
Inventory & Stock, Finance (AR/AP), and Production / Work Orders.

## What this is (and isn't)

- Runs entirely on your own PC. Nothing is sent anywhere except queries to
  your own SQL Server at `192.168.3.9\SQLEXPRESS`.
- Read-only. Every query is a `SELECT` — nothing here writes to your database.
- **The numbers need one round of verification before you trust them.**
  Several queries assume things about status/type codes (e.g. which code
  means "Sales Invoice", which means "Open Work Order") that aren't visible
  from the table structure alone. See "Verify your data" below — this is a
  10-minute step, not optional.

## Prerequisites

- **Node.js** installed on your PC (v18 or newer). Download from
  https://nodejs.org if you don't have it — the LTS installer is a normal
  Windows `.msi`, next-next-finish.
- Network access from this PC to `192.168.3.9\SQLEXPRESS` (you already
  confirmed this works from SSMS).

## Setup

1. Copy this whole `dashboard-app` folder to your PC (e.g. `Desktop\dashboard-app`).
2. Open Command Prompt in that folder (`cd Desktop\dashboard-app`).
3. Install dependencies:
   ```
   npm install
   ```
4. Copy `.env.example` to `.env`:
   ```
   copy .env.example .env
   ```
5. Open `.env` in Notepad and fill in your real `sa` password (and confirm
   the other values match your setup — they should already, based on your
   earlier connection).
6. Start the app:
   ```
   npm start
   ```
7. Open a browser to **http://localhost:3000**

You should see a green "Connected" dot in the bottom-left of the sidebar. If
it's red, check the terminal window for the exact error — it's almost always
either a wrong password in `.env`, or SQL Server Browser not running (see the
troubleshooting steps we worked through earlier for remote SSMS access —
they apply here too, since this app connects the same way SSMS does).

## Verify your data (do this before trusting the dashboard)

Open `diagnostics.sql` in SSMS and run each query against SYNCAXIS. They show
you which status/type codes actually appear in your data — e.g. what
`XWOSTATUS` values exist for work orders, or which `XIHDOCTYP` marks a Sales
Invoice. Share the results back in your Claude conversation, and the queries
in `queries.js` can be tightened to match your actual codes (right now a few
are intentionally broad, marked with `-- VERIFY` comments, so the dashboard
works out of the box but may include some rows you'd want to exclude, like
non-sales invoice types in the revenue figure).

## Project structure

```
dashboard-app/
  server.js          Express server + API routes
  db.js              SQL Server connection (uses SQL Server Browser + named instance)
  queries.js         All SQL, organized by module — edit business logic here
  diagnostics.sql    Run in SSMS to check real status/type code values
  public/
    index.html       Dashboard layout (sidebar + 5 module panels)
    style.css        Styling
    dashboard.js     Fetches API data, renders charts/tables
  .env.example       Copy to .env and fill in your password
```

## Keeping it running

`npm start` runs it in the foreground — closing the terminal window stops the
app. For something that stays running in the background, you can look into
`pm2` (`npm install -g pm2`, then `pm2 start server.js`) once you're happy
with the dashboard itself; not necessary for now.

## Extending it

Each module's data comes from 2-3 SQL queries in `queries.js`. To add a new
KPI or chart, add a query there, a new route in `server.js`, and a new
element + fetch call in `public/dashboard.js` / `index.html`. Bring any of
these back to Claude if you want help extending a specific module.
