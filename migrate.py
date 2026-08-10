"""
One-time migration for the Settings feature update.

The `user` table gained four new columns: dob, profile_pic, theme,
appearance. Flask-SQLAlchemy's db.create_all() only creates missing
*tables*, never adds columns to a table that already exists — so an
existing database needs this script run once against it.

Safe to run more than once: it checks which columns already exist and
only adds the ones that are missing. It does not touch or delete any
existing rows.

Usage:
    # local SQLite (uses the same default app.py falls back to)
    python migrate.py

    # against Render/production Postgres, set DATABASE_URL first, e.g.:
    #   DATABASE_URL="postgresql://..." python migrate.py
    # (On Render itself you can also open the web service's Shell tab
    # and just run `python migrate.py` — DATABASE_URL is already set
    # there.)
"""
import os

from sqlalchemy import create_engine, inspect, text

db_url = os.environ.get("DATABASE_URL", "sqlite:///expenses.db")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

engine = create_engine(db_url)
inspector = inspect(engine)

if "user" not in inspector.get_table_names():
    print('No "user" table found yet — nothing to migrate. '
          "Just run app.py normally; it'll create the table fresh.")
    raise SystemExit(0)

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

with engine.begin() as conn:
    for name, coltype in new_columns.items():
        if name in existing_columns:
            print(f"skip  {name} (already exists)")
            continue
        conn.execute(text(f'ALTER TABLE "user" ADD COLUMN {name} {coltype}'))
        print(f"added {name} {coltype}")

print("Migration complete — existing accounts default to the purple "
      "theme and system appearance, with no photo and no date of birth "
      "on file until they set one in Settings.")
