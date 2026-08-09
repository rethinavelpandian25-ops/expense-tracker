"""
Personal finance insights engine.

Generates plain-language, actionable observations from someone's own
transaction history: spending trends, categories worth reviewing, months
that ran tight, which income looks most reliable to build savings around,
and unusually large transactions worth a second look.

This is intentionally NOT a trained machine-learning model — it's
statistics (means, standard deviations, month-over-month deltas) applied
to the person's own data, run fresh on every request. That's an honest
description of what it is, and it's also what makes it reliable: every
insight below can be explained in one sentence, and improves automatically
as more transactions come in, with no training step required.

Pure Python / stdlib only, no Flask or DB imports — the whole thing is a
single function, `generate_insights(transactions)`, that's easy to unit
test with plain dicts.
"""
from collections import defaultdict
from datetime import date, datetime
from statistics import mean, pstdev

MIN_TRANSACTIONS_FOR_INSIGHTS = 5
SAVINGS_RATE_BENCHMARK = 0.20  # the classic "save 20% of income" rule of thumb
TIGHT_MONTH_RATIO = 0.85       # expenses at/above 85% of that month's income
LOW_VARIATION_THRESHOLD = 0.35  # coefficient of variation below this = "reliable" income
WEEKDAY_SPIKE_RATIO = 1.4       # a weekday averaging 40%+ above the mean stands out


def _parse_date(iso_str):
    return datetime.strptime(iso_str, "%Y-%m-%d").date()


def _month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def _month_label(ym_key):
    y, m = ym_key.split("-")
    return date(int(y), int(m), 1).strftime("%B %Y")


def _pct(part, whole):
    return round((part / whole) * 100) if whole else 0


def _coefficient_of_variation(values):
    if len(values) < 2:
        return None
    avg = mean(values)
    if avg == 0:
        return None
    return pstdev(values) / avg


def _insight(insight_id, severity, title, message):
    return {"id": insight_id, "severity": severity, "title": title, "message": message}


def generate_insights(transactions):
    """
    transactions: list of dicts shaped like Transaction.to_dict() —
    {id, type, category, amount, note, date} with date as 'YYYY-MM-DD'.

    Returns {"has_enough_data": bool, "insights": [...]}. Each insight has
    id / severity ("positive" | "info" | "warning" | "critical") / title /
    message — severity is a display hint only, not a claim of certainty.
    """
    if len(transactions) < MIN_TRANSACTIONS_FOR_INSIGHTS:
        return {"has_enough_data": False, "insights": []}

    rows = []
    for t in transactions:
        try:
            d = _parse_date(t["date"])
        except (KeyError, ValueError):
            continue
        rows.append({
            "type": t.get("type"),
            "category": (t.get("category") or "Uncategorized").strip() or "Uncategorized",
            "amount": float(t.get("amount") or 0),
            "date": d,
            "month": _month_key(d),
        })

    if len(rows) < MIN_TRANSACTIONS_FOR_INSIGHTS:
        return {"has_enough_data": False, "insights": []}

    expenses = [r for r in rows if r["type"] == "expense"]
    incomes = [r for r in rows if r["type"] == "income"]

    insights = []
    insights += _monthly_totals_insights(rows)
    insights += _top_expense_category_insight(expenses)
    insights += _frequent_small_expense_insight(expenses)
    insights += _spending_trend_insight(expenses)
    insights += _reliable_income_insight(incomes)
    insights += _anomaly_insight(expenses)
    insights += _weekday_pattern_insight(expenses)

    return {"has_enough_data": True, "insights": insights}


# ---------------------------------------------------------------------------
# Individual insight generators — each returns a list (0 or 1 items) so they
# can be concatenated freely and independently skip when data's too thin.
# ---------------------------------------------------------------------------
def _monthly_totals_insights(rows):
    """Savings-rate benchmark + the tightest ('critical') month on record."""
    by_month = defaultdict(lambda: {"income": 0.0, "expense": 0.0})
    for r in rows:
        by_month[r["month"]][r["type"] if r["type"] in ("income", "expense") else "expense"] += r["amount"]

    months_with_income = {
        ym: v for ym, v in by_month.items() if v["income"] > 0
    }
    if not months_with_income:
        return []

    out = []

    # Overall average savings rate across months that had income.
    rates = [(v["income"] - v["expense"]) / v["income"] for v in months_with_income.values()]
    avg_rate = mean(rates)
    if avg_rate >= SAVINGS_RATE_BENCHMARK:
        out.append(_insight(
            "savings_rate_overall", "positive",
            f"Averaging a {round(avg_rate * 100)}% savings rate",
            f"Across the months on record you're keeping about {round(avg_rate * 100)}% of your "
            f"income unspent — at or above the common 20% savings guideline. Consider directing "
            f"the surplus into a separate savings or investment account so it isn't gradually "
            f"absorbed into everyday spending.",
        ))
    else:
        gap = round((SAVINGS_RATE_BENCHMARK - avg_rate) * 100)
        out.append(_insight(
            "savings_rate_overall", "warning",
            f"Averaging a {round(avg_rate * 100)}% savings rate",
            f"That's about {gap} points below the common 20% savings guideline. Even shifting a "
            f"small fixed amount per paycheck into savings before spending the rest ('pay "
            f"yourself first') tends to close this gap without feeling like a big lifestyle change.",
        ))

    # Tightest month: highest expense/income ratio, at/above the threshold.
    tightest_ym, tightest_ratio = None, 0
    for ym, v in months_with_income.items():
        ratio = v["expense"] / v["income"]
        if ratio > tightest_ratio:
            tightest_ym, tightest_ratio = ym, ratio
    if tightest_ym and tightest_ratio >= TIGHT_MONTH_RATIO:
        v = months_with_income[tightest_ym]
        severity = "critical" if tightest_ratio >= 1 else "warning"
        if tightest_ratio >= 1:
            msg = (
                f"In {_month_label(tightest_ym)}, expenses (₹{v['expense']:,.0f}) actually "
                f"exceeded income (₹{v['income']:,.0f}). That's the tightest point in your "
                f"history on record — worth a closer look at what drove it before it repeats."
            )
        else:
            msg = (
                f"In {_month_label(tightest_ym)}, expenses used up {round(tightest_ratio * 100)}% "
                f"of income (₹{v['expense']:,.0f} of ₹{v['income']:,.0f}), leaving very little "
                f"buffer that month."
            )
        out.append(_insight(
            "critical_month", severity,
            f"{_month_label(tightest_ym)} was your tightest month",
            msg,
        ))

    return out


def _top_expense_category_insight(expenses):
    if not expenses:
        return []
    totals = defaultdict(float)
    for r in expenses:
        totals[r["category"]] += r["amount"]
    total_expense = sum(totals.values())
    if total_expense <= 0:
        return []

    top_cat, top_amt = max(totals.items(), key=lambda kv: kv[1])
    share = _pct(top_amt, total_expense)
    if share < 20:
        return []  # no single category dominates enough to be worth calling out

    severity = "critical" if share >= 45 else "warning"
    return [_insight(
        "top_expense_category", severity,
        f"{top_cat} is your biggest expense, at {share}% of spending",
        f"You've spent ₹{top_amt:,.0f} on {top_cat} — {share}% of everything you've logged as "
        f"an expense. Setting a monthly cap for this one category is usually the single most "
        f"effective lever for controlling overall spending, since it moves the most money.",
    )]


def _frequent_small_expense_insight(expenses):
    """Categories with many low-value transactions — the 'latte factor':
    individually small, but the frequency adds up to a meaningful total."""
    if not expenses:
        return []
    by_cat = defaultdict(list)
    for r in expenses:
        by_cat[r["category"]].append(r["amount"])
    total_expense = sum(sum(v) for v in by_cat.values())
    if total_expense <= 0:
        return []

    candidates = []
    for cat, amounts in by_cat.items():
        if len(amounts) < 4:
            continue
        avg = mean(amounts)
        cat_total = sum(amounts)
        share = cat_total / total_expense
        # "Frequent and small individually, but adds up": low average ticket
        # size relative to the category total, plus a meaningful overall share.
        if avg <= (cat_total / len(amounts)) and share >= 0.08 and avg < mean([a for v in by_cat.values() for a in v]) * 1.2:
            candidates.append((cat, len(amounts), avg, cat_total, share))

    if not candidates:
        return []

    # Prefer the one with the most transactions — the clearest "frequent small spend" signal.
    cat, count, avg, cat_total, share = max(candidates, key=lambda c: c[1])
    return [_insight(
        "frequent_small_expenses", "info",
        f"{count} small purchases in {cat} add up to ₹{cat_total:,.0f}",
        f"These average around ₹{avg:,.0f} each, easy to overlook individually, but together "
        f"they're {round(share * 100)}% of your spending. This is the classic pattern worth "
        f"reviewing first if you're trying to trim spending without giving up anything big.",
    )]


def _spending_trend_insight(expenses):
    by_month = defaultdict(float)
    for r in expenses:
        by_month[r["month"]] += r["amount"]
    months = sorted(by_month.keys())
    if len(months) < 2:
        return []

    prev_ym, last_ym = months[-2], months[-1]
    prev_total, last_total = by_month[prev_ym], by_month[last_ym]
    if prev_total <= 0:
        return []

    change = (last_total - prev_total) / prev_total
    if abs(change) < 0.12:
        return []  # roughly flat — not worth flagging

    if change > 0:
        return [_insight(
            "spending_trend", "warning" if change >= 0.25 else "info",
            f"Spending rose {round(change * 100)}% last month",
            f"{_month_label(last_ym)} expenses (₹{last_total:,.0f}) were up from "
            f"{_month_label(prev_ym)} (₹{prev_total:,.0f}). If that wasn't a one-off "
            f"(a trip, a repair), it's worth checking which category drove the increase.",
        )]
    return [_insight(
        "spending_trend", "positive",
        f"Spending dropped {round(abs(change) * 100)}% last month",
        f"{_month_label(last_ym)} expenses (₹{last_total:,.0f}) were down from "
        f"{_month_label(prev_ym)} (₹{prev_total:,.0f}) — whatever changed, it's working.",
    )]


def _reliable_income_insight(incomes):
    """Which income category is the most consistent month to month — the
    best candidate to build automatic savings/investing around, since
    irregular income is harder to commit a fixed amount from."""
    if not incomes:
        return []
    by_cat_month = defaultdict(lambda: defaultdict(float))
    for r in incomes:
        by_cat_month[r["category"]][r["month"]] += r["amount"]

    candidates = []
    for cat, months in by_cat_month.items():
        if len(months) < 2:
            continue
        values = list(months.values())
        cv = _coefficient_of_variation(values)
        if cv is None:
            continue
        candidates.append((cat, len(months), mean(values), cv))

    if not candidates:
        return []

    # Most reliable = lowest variation, tie-broken by showing up in more months.
    candidates.sort(key=lambda c: (c[3], -c[1]))
    cat, month_count, avg_amt, cv = candidates[0]
    if cv > LOW_VARIATION_THRESHOLD:
        return []  # nothing consistent enough to recommend anchoring savings to

    suggested = avg_amt * SAVINGS_RATE_BENCHMARK
    return [_insight(
        "reliable_income", "positive",
        f"{cat} is your most consistent income",
        f"It's shown up in {month_count} of your months on record averaging ₹{avg_amt:,.0f}, "
        f"with relatively little swing. Predictable income like this is the easiest to build "
        f"an automatic savings or investment habit around — for example, moving a fixed "
        f"₹{suggested:,.0f} (20%) the day it arrives, before it's available to spend.",
    )]


def _anomaly_insight(expenses):
    """A single transaction well outside its category's normal range.

    Uses a leave-one-out baseline (the category's mean/stdev computed from
    every OTHER transaction in that category) rather than including the
    candidate itself — otherwise a large outlier inflates the very average
    it's being compared against, understating how unusual it really is.
    """
    by_cat = defaultdict(list)
    for r in expenses:
        by_cat[r["category"]].append(r)

    best = None  # (z_score, row, baseline_mean)
    for cat, rows in by_cat.items():
        if len(rows) < 4:
            continue
        amounts = [r["amount"] for r in rows]
        for i, r in enumerate(rows):
            others = amounts[:i] + amounts[i + 1:]
            baseline_avg = mean(others)
            baseline_sd = pstdev(others)
            if baseline_sd == 0:
                continue
            z = (r["amount"] - baseline_avg) / baseline_sd
            if z >= 2 and (best is None or z > best[0]):
                best = (z, r, baseline_avg)

    if not best:
        return []
    _, row, baseline_avg = best
    return [_insight(
        "unusual_transaction", "warning",
        f"An unusually large {row['category']} expense",
        f"₹{row['amount']:,.0f} on {row['date'].strftime('%d %b %Y')} stands out — well above "
        f"the usual ₹{baseline_avg:,.0f} for {row['category']}. If it was a one-off (a repair, a "
        f"gift), no action needed; if it's becoming a pattern, it may be worth its own budget line.",
    )]


def _weekday_pattern_insight(expenses):
    if len(expenses) < 8:
        return []
    by_weekday = defaultdict(float)
    for r in expenses:
        by_weekday[r["date"].weekday()] += r["amount"]
    if len(by_weekday) < 4:
        return []

    totals = list(by_weekday.values())
    avg = mean(totals)
    if avg <= 0:
        return []
    top_day, top_total = max(by_weekday.items(), key=lambda kv: kv[1])
    if top_total < avg * WEEKDAY_SPIKE_RATIO:
        return []

    weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    return [_insight(
        "weekday_pattern", "info",
        f"You spend the most on {weekday_names[top_day]}s",
        f"₹{top_total:,.0f} has gone out on {weekday_names[top_day]}s in total, noticeably "
        f"above your other days. If that's discretionary spending (eating out, shopping), "
        f"setting a small per-weekend budget can help without cutting it out entirely.",
    )]
