# Ledger — Expense & Budget Tracker

A multi-user expense tracker. Each user signs up, logs in, and sees only
their own transactions. Data is stored in a real database (PostgreSQL in
production, SQLite for local development), so it persists across logins
and devices — it isn't just saved in the browser.

**Stack:** Flask (Python) backend serving a REST API + the HTML pages,
vanilla HTML/CSS/JS frontend, Chart.js for charts, PostgreSQL on Render.

## Features

- Sign up / log in / log out (passwords hashed, never stored in plain text)
- Add, view, and delete income/expense transactions with category, amount, date, note
- Dashboard with balance, total income, total expense
- Category breakdown chart (doughnut) and 6-month income vs. expense trend (bar chart)
- Filter history by type and month
- Fully responsive — sidebar nav on desktop, top bar + stacked cards on mobile
- Each user's data is isolated — user A can never see user B's transactions

## Project structure

```
expense-tracker/
├── app.py                 # Flask app: routes, models, API
├── requirements.txt
├── render.yaml             # Render deploy config (web service + Postgres)
├── .env.example
├── static/
│   ├── css/style.css
│   └── js/
│       ├── auth.js         # login/signup form logic
│       └── dashboard.js    # dashboard logic, charts, API calls
└── templates/
    ├── login.html
    ├── signup.html
    └── dashboard.html
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

## Known simplifications (worth knowing for an interview)

Being able to talk about what you'd add next is itself a good signal:

- No password reset flow (would need an email service like SendGrid)
- No CSRF token on forms (mitigated by `SameSite=Lax` cookies, but a
  dedicated CSRF library would be a good next step)
- No database migrations — schema changes currently require recreating
  tables; a real project would add `Flask-Migrate`
- No rate limiting on login/signup endpoints
