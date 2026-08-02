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


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    transactions = db.relationship(
        "Transaction", backref="user", lazy=True, cascade="all, delete-orphan"
    )

    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)


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
    return render_template("signup.html")


@app.route("/dashboard", methods=["GET"])
@login_required
def dashboard():
    return render_template("dashboard.html", username=current_user.username)


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not username or not email or not password:
        return jsonify({"error": "All fields are required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already taken."}), 409
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email already registered."}), 409

    user = User(username=username, email=email)
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


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
