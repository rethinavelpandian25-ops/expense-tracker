import os
from datetime import datetime, date, timedelta

from flask import Flask, render_template, request, jsonify, redirect, url_for, send_file
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user,
    login_required, current_user
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import extract, inspect, text
from io import BytesIO
import base64
import re

from insights import generate_insights
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                Image as RLImage, PageBreak, KeepTogether)
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------------------
# App / DB setup
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Render sets RENDER=true automatically in its environment, and serves
# everything over HTTPS — so cookies can be marked Secure there. Left off
# for local http://localhost development.
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("RENDER", "").lower() == "true"
# "Stay signed in" behavior: once someone logs in (or signs up), they stay
# logged in on that device/browser indefinitely via a separate persistent
# cookie, and are only asked to log in again after they explicitly log out
# (see login_user(..., remember=True) below). A year is a generous but
# bounded ceiling so a cookie doesn't linger forever on a shared machine.
app.config["REMEMBER_COOKIE_DURATION"] = timedelta(days=365)
app.config["REMEMBER_COOKIE_HTTPONLY"] = True
app.config["REMEMBER_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"] = app.config["SESSION_COOKIE_SECURE"]
# A profile photo is stored as a base64 data URL on the user row (see notes
# on PROFILE_PIC_MAX_CHARS below), so the JSON body for that one endpoint
# needs a higher limit than Flask's default.
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024  # 3 MB

# Render provides DATABASE_URL for its managed Postgres. Render's URL starts
# with "postgres://" but SQLAlchemy 1.4+ requires "postgresql://".
db_url = os.environ.get("DATABASE_URL", "sqlite:///expenses.db")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

login_manager = LoginManager(app)
login_manager.login_view = "login_page"

MIN_SIGNUP_AGE = 18

# Themes and appearance modes a user is allowed to pick in Settings. Kept in
# one place so the API and the seed defaults below always agree with what
# static/js/dashboard.js offers as swatches.
VALID_THEMES = {"purple", "blue", "green", "rose", "amber", "teal", "graphite"}
VALID_APPEARANCES = {"light", "dark", "system"}
DEFAULT_THEME = "purple"
DEFAULT_APPEARANCE = "system"

# Profile photos are stored inline as base64 data URLs on the user row
# instead of on disk — Render's free-tier filesystem is ephemeral and wipes
# any uploaded files on every deploy/restart, which would silently break
# photos. Postgres has no such issue, so the DB is the durable option here.
# 2_000_000 base64 characters is roughly a 1.4 MB source image, plenty for
# an avatar-sized photo while keeping row size sane.
PROFILE_PIC_MAX_CHARS = 2_000_000


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    dob = db.Column(db.Date, nullable=True)
    profile_pic = db.Column(db.Text, nullable=True)  # base64 data URL, or NULL
    theme = db.Column(db.String(20), nullable=False, default=DEFAULT_THEME)
    appearance = db.Column(db.String(10), nullable=False, default=DEFAULT_APPEARANCE)
    country = db.Column(db.String(60), nullable=False, default="India")
    currency_code = db.Column(db.String(8), nullable=False, default="INR")
    currency_symbol = db.Column(db.String(8), nullable=False, default="₹")
    currency_locale = db.Column(db.String(30), nullable=False, default="en-IN")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    transactions = db.relationship(
        "Transaction", backref="user", lazy=True, cascade="all, delete-orphan"
    )

    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)

    def to_account_dict(self):
        return {
            "username": self.username,
            "email": self.email,
            "profile_pic": self.profile_pic,
            "theme": self.theme,
            "appearance": self.appearance,
            "country": self.country,
            "currency_code": self.currency_code,
            "currency_symbol": self.currency_symbol,
            "currency_locale": self.currency_locale,
        }


class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    type = db.Column(db.String(10), nullable=False)  # "income" | "expense"
    category = db.Column(db.String(50), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    note = db.Column(db.String(255))
    txn_date = db.Column(db.Date, nullable=False, default=date.today)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "type": self.type,
            "category": self.category,
            "amount": self.amount,
            "note": self.note or "",
            "date": self.txn_date.isoformat(),
        }


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


def calculate_age(born, today=None):
    today = today or date.today()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login_page"))


@app.route("/login", methods=["GET"])
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return render_template("login.html")


@app.route("/signup", methods=["GET"])
def signup_page():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return render_template("signup.html", min_age=MIN_SIGNUP_AGE)


@app.route("/dashboard", methods=["GET"])
@login_required
def dashboard():
    return render_template(
        "dashboard.html",
        username=current_user.username,
        email=current_user.email,
        profile_pic=current_user.profile_pic,
        theme=current_user.theme or DEFAULT_THEME,
        appearance=current_user.appearance or DEFAULT_APPEARANCE,
        active_nav="overview",
    )


@app.route("/transactions", methods=["GET"])
@login_required
def transactions_page():
    return render_template(
        "transactions.html",
        username=current_user.username,
        email=current_user.email,
        profile_pic=current_user.profile_pic,
        theme=current_user.theme or DEFAULT_THEME,
        appearance=current_user.appearance or DEFAULT_APPEARANCE,
        active_nav="history",
    )


@app.route("/reports", methods=["GET"])
@login_required
def reports_page():
    return render_template(
        "reports.html",
        username=current_user.username,
        email=current_user.email,
        profile_pic=current_user.profile_pic,
        theme=current_user.theme or DEFAULT_THEME,
        appearance=current_user.appearance or DEFAULT_APPEARANCE,
        active_nav="charts",
    )


@app.route("/money-flow", methods=["GET"])
@login_required
def money_flow_page():
    if "LedgerAndroid" in request.headers.get("User-Agent", ""):
        return redirect(url_for("reports_page"))
    return render_template(
        "money_flow.html",
        username=current_user.username,
        email=current_user.email,
        profile_pic=current_user.profile_pic,
        theme=current_user.theme or DEFAULT_THEME,
        appearance=current_user.appearance or DEFAULT_APPEARANCE,
        active_nav="money_flow",
    )


@app.route("/settings", methods=["GET"])
@login_required
def settings_page():
    return render_template(
        "settings.html",
        username=current_user.username,
        email=current_user.email,
        profile_pic=current_user.profile_pic,
        theme=current_user.theme or DEFAULT_THEME,
        appearance=current_user.appearance or DEFAULT_APPEARANCE,
        active_nav="settings",
    )


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    dob_str = (data.get("dob") or "").strip()

    if not username or not email or not password or not dob_str:
        return jsonify({"error": "All fields are required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    try:
        dob = datetime.strptime(dob_str, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Date of birth must be a valid date."}), 400

    today = date.today()
    if dob > today:
        return jsonify({"error": "Date of birth can't be in the future."}), 400

    age = calculate_age(dob, today)
    if age < MIN_SIGNUP_AGE:
        return jsonify({
            "error": f"You must be at least {MIN_SIGNUP_AGE} years old to create an account."
        }), 400

    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already taken."}), 409
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email already registered."}), 409

    user = User(username=username, email=email, dob=dob, country="India", currency_code="INR", currency_symbol="₹", currency_locale="en-IN")
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    # remember=True: stay logged in on this device until an explicit logout,
    # rather than just for the browser session.
    login_user(user, remember=True)
    return jsonify({"message": "Account created.", "username": user.username}), 201


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    identifier = (data.get("username") or "").strip()
    password = data.get("password") or ""

    user = User.query.filter(
        (User.username == identifier) | (User.email == identifier.lower())
    ).first()

    if not user or not user.check_password(password):
        return jsonify({"error": "Invalid username or password."}), 401

    # remember=True: stay logged in on this device until an explicit logout,
    # rather than just for the browser session.
    login_user(user, remember=True)
    return jsonify({"message": "Logged in.", "username": user.username}), 200


@app.route("/api/logout", methods=["POST"])
@login_required
def api_logout():
    logout_user()
    return jsonify({"message": "Logged out."}), 200


@app.route("/api/account", methods=["DELETE"])
@login_required
def delete_account():
    # Grab the real row before logging out — logout_user() swaps
    # current_user for an AnonymousUserMixin, which has no .id to delete.
    user = db.session.get(User, current_user.id)
    logout_user()
    db.session.delete(user)  # cascade="all, delete-orphan" removes their transactions too
    db.session.commit()
    return jsonify({"message": "Account deleted."}), 200


# ---------------------------------------------------------------------------
# Account / settings API
# ---------------------------------------------------------------------------
@app.route("/api/account", methods=["GET"])
@login_required
def get_account():
    return jsonify(current_user.to_account_dict())


@app.route("/api/account/username", methods=["PUT"])
@login_required
def update_username():
    data = request.get_json(silent=True) or {}
    new_username = (data.get("username") or "").strip()

    if not new_username:
        return jsonify({"error": "Username is required."}), 400
    if len(new_username) > 80:
        return jsonify({"error": "Username must be 80 characters or fewer."}), 400
    if new_username != current_user.username and User.query.filter_by(username=new_username).first():
        return jsonify({"error": "Username already taken."}), 409

    current_user.username = new_username
    db.session.commit()
    return jsonify({"message": "Username updated.", "username": current_user.username}), 200


@app.route("/api/account/password", methods=["PUT"])
@login_required
def update_password():
    data = request.get_json(silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    if not current_user.check_password(current_password):
        return jsonify({"error": "Current password is incorrect."}), 401
    if len(new_password) < 6:
        return jsonify({"error": "New password must be at least 6 characters."}), 400

    current_user.set_password(new_password)
    db.session.commit()
    return jsonify({"message": "Password updated."}), 200


@app.route("/api/account/profile-picture", methods=["PUT"])
@login_required
def update_profile_picture():
    data = request.get_json(silent=True) or {}
    image_data = data.get("image") or ""

    if not image_data.startswith("data:image/"):
        return jsonify({"error": "Please upload a valid image file."}), 400
    if len(image_data) > PROFILE_PIC_MAX_CHARS:
        return jsonify({"error": "That photo is too large. Please choose a smaller image."}), 400

    current_user.profile_pic = image_data
    db.session.commit()
    return jsonify({"message": "Profile photo updated.", "profile_pic": current_user.profile_pic}), 200


@app.route("/api/account/profile-picture", methods=["DELETE"])
@login_required
def remove_profile_picture():
    current_user.profile_pic = None
    db.session.commit()
    return jsonify({"message": "Profile photo removed."}), 200


COUNTRY_CURRENCIES = {
    "India": {"code": "INR", "symbol": "₹", "locale": "en-IN"},
    "United States": {"code": "USD", "symbol": "$", "locale": "en-US"},
    "United Kingdom": {"code": "GBP", "symbol": "£", "locale": "en-GB"},
    "European Union": {"code": "EUR", "symbol": "€", "locale": "en-IE"},
    "Canada": {"code": "CAD", "symbol": "CA$", "locale": "en-CA"},
    "Australia": {"code": "AUD", "symbol": "A$", "locale": "en-AU"},
    "Singapore": {"code": "SGD", "symbol": "S$", "locale": "en-SG"},
    "United Arab Emirates": {"code": "AED", "symbol": "د.إ", "locale": "en-AE"},
    "Japan": {"code": "JPY", "symbol": "¥", "locale": "ja-JP"},
    "China": {"code": "CNY", "symbol": "¥", "locale": "zh-CN"},
    "South Korea": {"code": "KRW", "symbol": "₩", "locale": "ko-KR"},
    "New Zealand": {"code": "NZD", "symbol": "NZ$", "locale": "en-NZ"},
    "Switzerland": {"code": "CHF", "symbol": "CHF", "locale": "de-CH"},
    "South Africa": {"code": "ZAR", "symbol": "R", "locale": "en-ZA"},
    "Brazil": {"code": "BRL", "symbol": "R$", "locale": "pt-BR"},
}

@app.route("/api/account/preferences", methods=["PUT"])
@login_required
def update_preferences():
    data = request.get_json(silent=True) or {}
    theme = data.get("theme")
    appearance = data.get("appearance")
    country = data.get("country")

    if theme is not None:
        if theme not in VALID_THEMES:
            return jsonify({"error": "Unknown theme."}), 400
        current_user.theme = theme
    if appearance is not None:
        if appearance not in VALID_APPEARANCES:
            return jsonify({"error": "Unknown appearance mode."}), 400
    if country is not None:
        if country not in COUNTRY_CURRENCIES:
            return jsonify({"error": "Unknown country."}), 400
        c = COUNTRY_CURRENCIES[country]
        current_user.country = country
        current_user.currency_code = c["code"]
        current_user.currency_symbol = c["symbol"]
        current_user.currency_locale = c["locale"]

    db.session.commit()
    return jsonify({
        "message": "Preferences saved.",
        "theme": current_user.theme,
        "appearance": current_user.appearance,
        "country": current_user.country,
        "currency_code": current_user.currency_code,
        "currency_symbol": current_user.currency_symbol,
        "currency_locale": current_user.currency_locale,
    }), 200


# ---------------------------------------------------------------------------
# Transaction API  (all scoped to current_user — users never see each other's data)
# ---------------------------------------------------------------------------
@app.route("/api/transactions", methods=["GET"])
@login_required
def get_transactions():
    month = request.args.get("month", type=int)
    year = request.args.get("year", type=int)
    txn_type = request.args.get("type")
    category = request.args.get("category")
    # Optional cap on how many rows come back — the dashboard's "recent
    # transactions" preview uses this so it doesn't have to pull someone's
    # entire history just to show the latest 7. Omit it (as the full
    # Transactions page does) to get everything, same as before.
    limit = request.args.get("limit", type=int)

    query = Transaction.query.filter_by(user_id=current_user.id)
    if month:
        query = query.filter(extract("month", Transaction.txn_date) == month)
    if year:
        query = query.filter(extract("year", Transaction.txn_date) == year)
    if txn_type in ("income", "expense"):
        query = query.filter_by(type=txn_type)
    if category:
        query = query.filter_by(category=category)

    query = query.order_by(Transaction.txn_date.desc(), Transaction.id.desc())
    if limit:
        query = query.limit(limit)

    txns = query.all()
    return jsonify([t.to_dict() for t in txns])


@app.route("/api/transactions", methods=["POST"])
@login_required
def add_transaction():
    data = request.get_json(silent=True) or {}
    txn_type = data.get("type")
    category = (data.get("category") or "").strip()
    amount = data.get("amount")
    note = (data.get("note") or "").strip()
    txn_date = data.get("date")

    if txn_type not in ("income", "expense"):
        return jsonify({"error": "type must be 'income' or 'expense'."}), 400
    if not category:
        return jsonify({"error": "Category is required."}), 400
    try:
        amount = float(amount)
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "Amount must be a positive number."}), 400

    try:
        parsed_date = datetime.strptime(txn_date, "%Y-%m-%d").date() if txn_date else date.today()
    except ValueError:
        return jsonify({"error": "Date must be in YYYY-MM-DD format."}), 400

    txn = Transaction(
        user_id=current_user.id,
        type=txn_type,
        category=category,
        amount=amount,
        note=note,
        txn_date=parsed_date,
    )
    db.session.add(txn)
    db.session.commit()
    return jsonify(txn.to_dict()), 201


@app.route("/api/transactions/<int:txn_id>", methods=["PUT"])
@login_required
def update_transaction(txn_id):
    txn = Transaction.query.filter_by(id=txn_id, user_id=current_user.id).first()
    if not txn:
        return jsonify({"error": "Transaction not found."}), 404

    data = request.get_json(silent=True) or {}
    if "type" in data:
        if data["type"] not in ("income", "expense"):
            return jsonify({"error": "type must be 'income' or 'expense'."}), 400
        txn.type = data["type"]
    if "category" in data:
        if not data["category"].strip():
            return jsonify({"error": "Category cannot be empty."}), 400
        txn.category = data["category"].strip()
    if "amount" in data:
        try:
            amount = float(data["amount"])
            if amount <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Amount must be a positive number."}), 400
        txn.amount = amount
    if "note" in data:
        txn.note = data["note"].strip()
    if "date" in data:
        try:
            txn.txn_date = datetime.strptime(data["date"], "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"error": "Date must be in YYYY-MM-DD format."}), 400

    db.session.commit()
    return jsonify(txn.to_dict())


@app.route("/api/transactions/<int:txn_id>", methods=["DELETE"])
@login_required
def delete_transaction(txn_id):
    txn = Transaction.query.filter_by(id=txn_id, user_id=current_user.id).first()
    if not txn:
        return jsonify({"error": "Transaction not found."}), 404
    db.session.delete(txn)
    db.session.commit()
    return jsonify({"message": "Deleted."}), 200


@app.route("/api/transactions/clear", methods=["DELETE"])
@login_required
def clear_transactions():
    Transaction.query.filter_by(user_id=current_user.id).delete()
    db.session.commit()
    return jsonify({"message": "All transactions deleted."}), 200


@app.route("/api/summary", methods=["GET"])
@login_required
def summary():
    txns = Transaction.query.filter_by(user_id=current_user.id).all()

    total_income = sum(t.amount for t in txns if t.type == "income")
    total_expense = sum(t.amount for t in txns if t.type == "expense")

    by_category = {}
    for t in txns:
        if t.type == "expense":
            by_category[t.category] = by_category.get(t.category, 0) + t.amount

    monthly = {}
    for t in txns:
        key = t.txn_date.strftime("%Y-%m")
        bucket = monthly.setdefault(key, {"income": 0, "expense": 0})
        bucket[t.type] += t.amount

    monthly_sorted = dict(sorted(monthly.items())[-6:])  # last 6 months

    return jsonify({
        "total_income": round(total_income, 2),
        "total_expense": round(total_expense, 2),
        "balance": round(total_income - total_expense, 2),
        "by_category": by_category,
        "monthly": monthly_sorted,
    })


@app.route("/api/insights", methods=["GET"])
@login_required
def api_insights():
    # generate_insights (insights.py) is plain Python with no DB/Flask
    # dependencies — it just needs plain dicts shaped like Transaction rows,
    # so all this route does is fetch and hand them over.
    txns = Transaction.query.filter_by(user_id=current_user.id).all()
    result = generate_insights([t.to_dict() for t in txns])
    return jsonify(result)


@app.route("/api/reports/pdf", methods=["GET"])
@login_required
def reports_pdf():
    """Generate a polished, self-contained financial report PDF."""
    txns = Transaction.query.filter_by(user_id=current_user.id).order_by(Transaction.txn_date.asc(), Transaction.id.asc()).all()
    income = sum(float(t.amount) for t in txns if t.type == "income")
    expense = sum(float(t.amount) for t in txns if t.type == "expense")
    balance = income - expense
    by_cat = {}
    monthly = {}
    for t in txns:
        if t.type == "expense":
            by_cat[t.category] = by_cat.get(t.category, 0) + float(t.amount)
        key = t.txn_date.strftime("%Y-%m")
        monthly.setdefault(key, {"income": 0, "expense": 0})[t.type] += float(t.amount)

    insights = generate_insights([t.to_dict() for t in txns])
    symbol = current_user.currency_symbol or "₹"

    def money(v):
        return f"{symbol}{v:,.2f}"

    def chart_png(kind):
        fig, ax = plt.subplots(figsize=(8.5, 3.5), dpi=150)
        fig.patch.set_alpha(0)
        if kind == "monthly":
            keys = list(monthly.keys())[-8:]
            inc = [monthly[k]["income"] for k in keys]
            exp = [monthly[k]["expense"] for k in keys]
            x = list(range(len(keys)))
            w = 0.36
            ax.bar([i-w/2 for i in x], inc, width=w, label="Income", color="#16a34a", alpha=.9)
            ax.bar([i+w/2 for i in x], exp, width=w, label="Expense", color="#ef4444", alpha=.9)
            ax.set_xticks(x, [k[2:] for k in keys])
            ax.set_title("Monthly Income vs Expense")
        elif kind == "category":
            items = sorted(by_cat.items(), key=lambda x: x[1], reverse=True)[:8]
            if items:
                labels = [x[0] for x in items]
                vals = [x[1] for x in items]
                ax.barh(labels[::-1], vals[::-1], color="#6366f1", alpha=.9)
            ax.set_title("Expense Categories")
        else:
            keys = list(monthly.keys())[-8:]
            net = [monthly[k]["income"] - monthly[k]["expense"] for k in keys]
            inc = [monthly[k]["income"] for k in keys]
            exp = [monthly[k]["expense"] for k in keys]
            ax.plot(keys, inc, marker="o", linewidth=2.2, color="#16a34a", label="Income")
            ax.plot(keys, exp, marker="o", linewidth=2.2, color="#ef4444", label="Expense")
            ax.bar(keys, net, alpha=.16, color="#6366f1", label="Net cash flow")
            ax.axhline(0, linewidth=1, color="#64748b")
            ax.set_title("Cash Flow")
        ax.grid(axis="y", alpha=.16)
        ax.tick_params(axis="x", rotation=0, labelsize=8)
        ax.tick_params(axis="y", labelsize=8)
        ax.legend(fontsize=8, frameon=False)
        fig.tight_layout()
        out = BytesIO(); fig.savefig(out, format="png", bbox_inches="tight", transparent=True); plt.close(fig); out.seek(0)
        return out

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, rightMargin=16*mm, leftMargin=16*mm, topMargin=15*mm, bottomMargin=15*mm)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="ReportTitle", parent=styles["Title"], fontSize=22, leading=26, textColor=colors.HexColor("#111827"), spaceAfter=4))
    styles.add(ParagraphStyle(name="SmallMuted", parent=styles["Normal"], fontSize=8.5, textColor=colors.HexColor("#64748b"), leading=12))
    styles.add(ParagraphStyle(name="Section", parent=styles["Heading2"], fontSize=13, leading=16, textColor=colors.HexColor("#312e81"), spaceBefore=9, spaceAfter=6))
    styles.add(ParagraphStyle(name="Body2", parent=styles["BodyText"], fontSize=9.2, leading=13, textColor=colors.HexColor("#334155")))

    story=[]
    header_data=[]
    if current_user.profile_pic and current_user.profile_pic.startswith("data:image/"):
        try:
            raw = base64.b64decode(current_user.profile_pic.split(",",1)[1])
            avatar = RLImage(BytesIO(raw), width=22*mm, height=22*mm)
        except Exception:
            avatar = Paragraph("", styles["Body2"])
    else:
        avatar = Paragraph(f"<b>{(current_user.username or '?')[0].upper()}</b>", ParagraphStyle(name="AvatarText", parent=styles["Body2"], fontSize=20, alignment=TA_CENTER, textColor=colors.white, backColor=colors.HexColor("#6366f1"), leading=22*mm))
    header_text = [Paragraph("Ledger Financial Report", styles["ReportTitle"]), Paragraph(f"{current_user.username} · {current_user.email}", styles["Body2"]), Paragraph(f"Country: {current_user.country} · Currency: {current_user.currency_code} ({symbol})", styles["SmallMuted"]), Paragraph(f"Generated {datetime.now().strftime('%d %b %Y, %I:%M %p')}", styles["SmallMuted"])]
    t=Table([[avatar, header_text]], colWidths=[28*mm, 145*mm])
    t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('BACKGROUND',(0,0),(0,0),colors.HexColor('#6366f1')),('BOX',(0,0),(0,0),0,colors.white),('LEFTPADDING',(1,0),(1,0),8)]))
    story += [t, Spacer(1,8)]

    stats=[[Paragraph("Total income",styles["SmallMuted"]),Paragraph("Total expense",styles["SmallMuted"]),Paragraph("Net balance",styles["SmallMuted"]),Paragraph("Savings rate",styles["SmallMuted"])], [Paragraph(f"<b>{money(income)}</b>",styles["Body2"]),Paragraph(f"<b>{money(expense)}</b>",styles["Body2"]),Paragraph(f"<b>{money(balance)}</b>",styles["Body2"]),Paragraph(f"<b>{(balance/income*100 if income else 0):.1f}%</b>",styles["Body2"])]]
    st=Table(stats,colWidths=[43*mm]*4)
    st.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#f8fafc')),('BOX',(0,0),(-1,-1),0.5,colors.HexColor('#e2e8f0')),('INNERGRID',(0,0),(-1,-1),0.35,colors.HexColor('#e2e8f0')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
    story += [st, Paragraph("Charts & cash-flow analysis", styles["Section"])]
    for kind in ("monthly","category","cashflow"):
        story.append(RLImage(chart_png(kind), width=175*mm, height=72*mm))
        story.append(Spacer(1,4))

    story.append(Paragraph("Transaction details", styles["Section"]))
    rows=[["Date","Type","Category","Note","Amount"]]
    for t in txns:
        rows.append([t.txn_date.strftime("%d %b %Y"),t.type.title(),t.category,(t.note or "—")[:55],money(float(t.amount))])
    if len(rows)==1: rows.append(["—","—","No transactions","Add transactions to build your report.","—"])
    table=Table(rows,colWidths=[24*mm,20*mm,30*mm,67*mm,30*mm],repeatRows=1)
    table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#312e81')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('FONTSIZE',(0,0),(-1,-1),7.5),('GRID',(0,0),(-1,-1),0.3,colors.HexColor('#e2e8f0')),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f8fafc')]),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    story.append(table)

    story.append(Paragraph("Smart insights", styles["Section"]))
    if insights.get("insights"):
        for ins in insights["insights"]:
            story.append(KeepTogether([Paragraph(f"<b>{ins.get('title','Insight')}</b>", styles["Body2"]), Paragraph(ins.get("message", ""), styles["SmallMuted"]), Spacer(1,4)]))
    else:
        story.append(Paragraph("Not enough transaction history for personalized insights yet.", styles["Body2"]))

    story.append(Spacer(1,8))
    story.append(Paragraph("This report is generated from your Ledger transaction history. Smart insights are informational and not financial advice.", styles["SmallMuted"]))
    doc.build(story)
    buf.seek(0)
    filename = f"ledger-report-{date.today().isoformat()}.pdf"
    return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name=filename)

@app.route("/api/money-flow", methods=["GET"])
@login_required
def api_money_flow():
    # Totals by category, split by income vs. expense — everything the
    # Money Flow (Sankey) diagram needs to draw income sources flowing
    # into "Income" and back out to expense categories + savings.
    txns = Transaction.query.filter_by(user_id=current_user.id).all()

    income_by_category = {}
    expense_by_category = {}
    total_income = 0.0
    total_expense = 0.0
    for t in txns:
        if t.type == "income":
            income_by_category[t.category] = income_by_category.get(t.category, 0) + t.amount
            total_income += t.amount
        else:
            expense_by_category[t.category] = expense_by_category.get(t.category, 0) + t.amount
            total_expense += t.amount

    return jsonify({
        "income_by_category": income_by_category,
        "expense_by_category": expense_by_category,
        "total_income": round(total_income, 2),
        "total_expense": round(total_expense, 2),
        "savings": round(total_income - total_expense, 2),
    })


# ---------------------------------------------------------------------------
# Flask-Login calls this whenever @login_required blocks an unauthenticated
# request. Without this override it always redirects to the login page,
# which breaks fetch() calls from the dashboard (they'd get an HTML page
# back instead of JSON). API routes get a clean 401 JSON response instead.
# ---------------------------------------------------------------------------
@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith("/api/"):
        return jsonify({"error": "Please log in."}), 401
    return redirect(url_for("login_page"))


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "That upload is too large."}), 413


def run_startup_migrations():
    """
    db.create_all() (below) only creates *missing tables* — it never adds a
    new column to a table that already exists. That's exactly what upgrading
    an existing deployment needs, though, and platforms like Render's free
    tier don't include a Shell/terminal to run a one-off migration script by
    hand. So instead, this runs automatically on every startup: it checks
    which of the newer `user` columns (dob, profile_pic, theme, appearance)
    are already there and adds whichever ones are missing. Existing rows are
    never touched or dropped, and columns that already exist are skipped, so
    it's safe to run on every single restart.
    """
    inspector = inspect(db.engine)
    if "user" not in inspector.get_table_names():
        return  # brand new database — create_all() above already built it correctly

    existing_columns = {col["name"] for col in inspector.get_columns("user")}
    new_columns = {
        "dob": "DATE",
        "profile_pic": "TEXT",
        "theme": "VARCHAR(20) NOT NULL DEFAULT 'purple'",
        "appearance": "VARCHAR(10) NOT NULL DEFAULT 'system'",
        "country": "VARCHAR(60) NOT NULL DEFAULT 'India'",
        "currency_code": "VARCHAR(8) NOT NULL DEFAULT 'INR'",
        "currency_symbol": "VARCHAR(8) NOT NULL DEFAULT '₹'",
        "currency_locale": "VARCHAR(30) NOT NULL DEFAULT 'en-IN'",
    }
    with db.engine.begin() as conn:
        for name, coltype in new_columns.items():
            if name in existing_columns:
                continue
            conn.execute(text(f'ALTER TABLE "user" ADD COLUMN {name} {coltype}'))
            print(f"[migration] added user.{name}")


with app.app_context():
    db.create_all()
    run_startup_migrations()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
