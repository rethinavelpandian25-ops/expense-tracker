import os
from datetime import datetime, date

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user,
    login_required, current_user
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import extract

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

    user = User(username=username, email=email, dob=dob)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    login_user(user)
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

    login_user(user)
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


@app.route("/api/account/preferences", methods=["PUT"])
@login_required
def update_preferences():
    data = request.get_json(silent=True) or {}
    theme = data.get("theme")
    appearance = data.get("appearance")

    if theme is not None:
        if theme not in VALID_THEMES:
            return jsonify({"error": "Unknown theme."}), 400
        current_user.theme = theme
    if appearance is not None:
        if appearance not in VALID_APPEARANCES:
            return jsonify({"error": "Unknown appearance mode."}), 400
        current_user.appearance = appearance

    db.session.commit()
    return jsonify({
        "message": "Preferences saved.",
        "theme": current_user.theme,
        "appearance": current_user.appearance,
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

    query = Transaction.query.filter_by(user_id=current_user.id)
    if month:
        query = query.filter(extract("month", Transaction.txn_date) == month)
    if year:
        query = query.filter(extract("year", Transaction.txn_date) == year)
    if txn_type in ("income", "expense"):
        query = query.filter_by(type=txn_type)
    if category:
        query = query.filter_by(category=category)

    txns = query.order_by(Transaction.txn_date.desc(), Transaction.id.desc()).all()
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


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
