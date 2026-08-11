# Ledger — Expense & Budget Tracker

A multi-user expense tracker. Each user signs up, logs in, and sees only
their own transactions. Data is stored in a real database (PostgreSQL in
production, SQLite for local development), so it persists across logins
and devices — it isn't just saved in the browser.

**Stack:** Flask (Python) backend serving a REST API + the HTML pages,
vanilla HTML/CSS/JS frontend, Chart.js for charts, PostgreSQL on Render.

## Features

- Sign up / log in / log out (passwords hashed, never stored in plain text)
- Sign-up asks for date of birth and only creates the account if the
  person is 18 or older (checked in the browser for instant feedback, and
  re-checked on the server since that's the actual source of truth)
- **Stay signed in** — logging in or signing up keeps you signed in on that
  device/browser indefinitely (via a long-lived cookie), so you're not
  asked to log in again until you explicitly log out
- Show/hide toggle on every password field (login, signup, and all three
  password fields in Settings)
- Add, view, edit, and delete income/expense transactions with category,
  amount, date, note
- Dashboard shows your balance, top categories, and only your **7 most
  recent transactions**, with a "Load more" link to the full
  **Transactions** page
- **Transactions page** (`/transactions`, its own page) — the complete
  history: filter by type/month, free-text search, edit/delete any entry,
  Clear all, and PDF export with a choice between the current filtered
  view or the full history
- Dashboard also has its own one-click "download full history as PDF"
  button, for when you just want everything without visiting the
  Transactions page
- **Reports page** (`/reports`, its own page) — replaces what used to be a
  section on the dashboard:
  - **Smart insights**: plain-language, actionable observations generated
    from patterns in your own transaction history — biggest expense
    category, month-over-month spending trend, your tightest month,
    an unusually large transaction worth a second look, which income
    source is most reliable to build savings around, and more. This is
    rule-based statistical analysis (means, trends, variance) run fresh on
    your data each time, not a trained ML model — labeled honestly as
    such on the page, and it improves automatically as you log more
    transactions, no training step involved
  - Category breakdown chart (doughnut, with animated proportion bars in
    the legend) and 6-month income vs. expense trend (bar chart), plus a
    cashflow line chart
  - An animated circular "this month's savings rate" gauge that
    color-codes itself (green/amber/red) based on how healthy the rate is
  - Count-up number animations, staggered card entrances, and tuned chart
    animation timing throughout
- **Settings page** (`/settings`, its own page) — everything about the
  signed-in person's account:
  - Upload/remove a profile photo (shown as the round avatar everywhere);
    the photo is resized and compressed in the browser before it's ever
    sent, so uploads stay small
  - Change username or password
  - Pick an accent theme (purple by default, plus blue/green/rose/amber/teal/graphite)
  - Switch appearance between light, dark, or system (system is the
    default, and it live-updates if the OS theme changes while the tab is
    open)
  - Log out and delete account — both ask for confirmation before doing
    anything irreversible, same as deleting a transaction or clearing history
- Theme and appearance choices are saved per-account and re-applied on
  every future login, on any device, with no flash of the wrong theme on load
- Icons on every main nav item (Dashboard, Transactions, Reports, Settings),
  desktop sidebar and mobile bottom bar alike
- Fully responsive — sidebar nav on desktop, top bar + stacked cards on
  mobile
- Subtle animations throughout (section transitions, modal entrances, hover
  states) that respect `prefers-reduced-motion`
- Browser tab favicon (the ₹ mark), plus a web manifest for "add to home
  screen" on mobile
- Each user's data is isolated — user A can never see user B's transactions

## Project structure

```
expense-tracker/
├── app.py                     # Flask app: routes, models, API
├── insights.py                 # rule-based "smart insights" engine (pure Python, unit-testable)
├── migrate.py                 # one-time DB column migration (see below)
├── requirements.txt
├── render.yaml                 # Render deploy config (web service + Postgres)
├── .env.example
├── static/
│   ├── favicon.svg / favicon.ico / site.webmanifest
│   ├── icons/                  # PNG favicons at every size browsers ask for
│   ├── css/style.css           # design tokens, theme + dark-mode variables, layout
│   └── js/
│       ├── auth.js             # login/signup form logic
│       ├── password-toggle.js  # show/hide toggle, shared by login/signup/settings
│       ├── dashboard.js        # dashboard: 7-recent preview, top categories
│       ├── transactions.js     # full Transactions page: filters, search, CRUD, PDF
│       ├── reports.js          # Reports page: charts, insights rendering, animations
│       └── settings.js         # settings page: profile, theme, appearance
└── templates/
    ├── app_shell.html          # shared sidebar/topbar/modal layout (base template)
    ├── _icons.html             # shared inline-SVG icon macros
    ├── _forms.html             # shared password-field macro (with show/hide button)
    ├── login.html
    ├── signup.html
    ├── dashboard.html           # extends app_shell.html — recent-transactions preview
    ├── transactions.html        # extends app_shell.html — full transaction history
    ├── reports.html              # extends app_shell.html — charts + smart insights
    └── settings.html            # extends app_shell.html — account settings
```

## 1. Run it locally

You said you already have VS Code, Python, and GitHub set up, so:

```bash
cd expense-tracker
python -m venv venv

# Windows
venv\Scripts\activate
# Mac/Linux
source venv/bin/activate

pip install -r requirements-local.txt
python app.py
```

> **Why `requirements-local.txt`?** `requirements.txt` includes `psycopg2-binary`
> (talks to PostgreSQL) and `gunicorn` (a production server) — both only
> needed once the app is deployed on Render's Linux servers, where they
> install cleanly. Locally you're running on SQLite with Flask's own
> dev server, so `requirements-local.txt` skips both and avoids the
> Windows build-tool errors psycopg2 can throw. Render's build step uses
> `requirements.txt` (see `render.yaml`), so production is unaffected.

Open **http://localhost:5000** — it will redirect you to the login page.
Sign up for an account, and you're in. Locally, with no `DATABASE_URL`
set, it automatically uses a SQLite file (`expenses.db`) so you don't
need Postgres installed to develop.

> **Schema changes / `migrate.py`:** the `User` table has picked up new
> columns over time (date of birth, profile photo, theme, appearance).
> `app.py` actually runs a small self-migration automatically on every
> startup now (see `run_startup_migrations()` in `app.py`), so on Render
> this fixes itself on the next deploy with no manual step. `migrate.py`
> is kept as a standalone version of the same fix, for local use or any
> environment where you'd rather run it by hand.

## 2. Push to GitHub

```bash
cd expense-tracker
git init
git add .
git commit -m "Initial commit: expense tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

(The `.gitignore` already excludes your local `.db` file and any `.env`,
so you won't accidentally commit secrets or personal data.)

## 3. Deploy on Render (with a real online database)

**Option A — one-click with the blueprint file (recommended)**

1. Go to [render.com](https://render.com) and sign in with GitHub.
2. Click **New +** → **Blueprint**.
3. Select your repo. Render will detect `render.yaml` and set up
   *both* the web service and a free PostgreSQL database automatically,
   wiring `DATABASE_URL` between them for you.
4. Click **Apply**. First deploy takes a few minutes.

**Option B — manual setup**

1. On Render, click **New +** → **PostgreSQL**. Name it, choose the free
   plan, create it. Copy the **Internal Database URL** once it's ready.
2. Click **New +** → **Web Service**, connect your GitHub repo.
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn app:app`
3. Under **Environment**, add:
   - `SECRET_KEY` → any random string
   - `DATABASE_URL` → the Internal Database URL from step 1
4. Click **Create Web Service**.

Either way, once it's live, Render gives you a public URL like
`https://your-app.onrender.com` — that's the link you put on your resume.

> **Free tier note:** Render's free web services spin down after a period
> of inactivity and take ~30–50 seconds to wake up on the next visit.
> Mention this if you're demoing it live, so a slow first load doesn't
> look like a bug.
>
> **Profile photos on the free tier:** photos are stored as base64 text
> on the user's database row (not as files on disk), specifically because
> Render's free filesystem is wiped on every deploy/restart. Keep this in
> mind if you ever move to storing larger files — you'd want S3/Cloud
> Storage instead of the database at that point.

## Running this as an Android app

The web app is already a fully installable Progressive Web App (manifest,
service worker, icons at every required size) — that's what makes it
possible to turn into a real Android app without rewriting anything. See
**[`mobile/README.md`](mobile/README.md)** for two ways to do it:

- **PWABuilder** — generate a signed, installable `.apk` from your live URL
  in about 10 minutes, no coding tools needed.
- **Capacitor** — a proper Android Studio project for Play Store
  publishing or adding native features later.

Both just load your live deployed site inside a native Android shell, so
new features you add to the web app show up in the Android app automatically.

## Known simplifications (worth knowing for an interview)

Being able to talk about what you'd add next is itself a good signal:

- No password reset flow (would need an email service like SendGrid)
- No CSRF token on forms (mitigated by `SameSite=Lax` cookies, but a
  dedicated CSRF library would be a good next step)
- No formal database migration tool — `run_startup_migrations()` in
  `app.py` handles the columns this project has added so far, but a
  bigger schema change would still want `Flask-Migrate`
- No rate limiting on login/signup endpoints
- No email verification, so the age check at signup relies on the date
  of birth the person enters — there's no way to independently verify it
