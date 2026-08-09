// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let categoryChart = null;
let monthlyBarChart = null;
let cashflowChart = null;
let cashflowMode = "income";
let lastMonthlyData = {};

// Populated server-side (see the inline script in app_shell.html) so the
// page already knows the signed-in user without an extra round trip.
const account = window.LEDGER_USER || { username: "", profile_pic: null };

const currency = (n) =>
  "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const monthLabel = (ymKey) => {
  const [y, m] = ymKey.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("default", { month: "short", year: "numeric" });
};

// Reads a live CSS custom property off <html> so chart colors always match
// the current theme + light/dark appearance chosen in Settings.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// Small inline icon set for insight severities — kept local to this file
// since insight cards are built dynamically (the shared Jinja icon macro
// only helps with server-rendered markup).
const SEVERITY_ICONS = {
  critical: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  positive: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  info: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0012 2z"/></svg>',
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();

  document.querySelectorAll(".pill-btn[data-cashflow]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pill-btn[data-cashflow]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      cashflowMode = btn.dataset.cashflow;
      renderCashflowChart(lastMonthlyData);
    });
  });

  loadReports();
});

function renderAvatars() {
  const avatarBtn = document.getElementById("avatarBtn");
  const sidebarAvatar = document.getElementById("sidebarAvatar");
  [avatarBtn, sidebarAvatar].forEach((el) => {
    if (!el) return;
    if (account.profile_pic) {
      el.innerHTML = `<img src="${account.profile_pic}" alt="Profile photo" />`;
    } else {
      el.textContent = (account.username || "?").charAt(0).toUpperCase();
    }
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not authenticated");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadReports() {
  const [summaryData] = await Promise.all([loadSummary(), loadInsights()]);
  return summaryData;
}

// ---------------------------------------------------------------------------
// Summary: stat cards, gauge, charts
// ---------------------------------------------------------------------------
async function loadSummary() {
  const summaryData = await apiFetch("/api/summary");
  lastMonthlyData = summaryData.monthly;

  countUpTo("reportIncomeValue", summaryData.total_income);
  countUpTo("reportExpenseValue", summaryData.total_expense);
  renderSavingsGauge(summaryData.monthly);

  renderCategoryChart(summaryData.by_category);
  renderMonthlyBarChart(summaryData.monthly);
  renderCashflowChart(summaryData.monthly);

  return summaryData;
}

// Animates a currency value counting up from 0 — small, well-established
// pattern for making a dashboard feel alive rather than just appearing.
function countUpTo(elementId, target, duration = 900) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const start = performance.now();
  const startVal = 0;

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const value = startVal + (target - startVal) * eased;
    el.textContent = currency(value);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = currency(target);
  }
  requestAnimationFrame(tick);
}

// Circular "this month's savings rate" gauge. Colors and label adapt to
// how healthy the rate is; the ring fills via an animated stroke-dashoffset.
function renderSavingsGauge(monthly) {
  const valueEl = document.getElementById("savingsRateValue");
  const labelEl = document.getElementById("savingsRateLabel");
  const fillEl = document.getElementById("gaugeFill");

  const months = Object.keys(monthly).sort();
  const lastMonth = months[months.length - 1];
  const circumference = 2 * Math.PI * 42;
  fillEl.style.strokeDasharray = `${circumference}`;
  fillEl.style.strokeDashoffset = `${circumference}`; // start empty, animate to target

  if (!lastMonth || !monthly[lastMonth] || monthly[lastMonth].income <= 0) {
    valueEl.textContent = "—";
    labelEl.textContent = "Not enough data yet this month";
    fillEl.style.stroke = cssVar("--muted");
    return;
  }

  const { income, expense } = monthly[lastMonth];
  const rate = (income - expense) / income; // can be negative
  const displayPct = Math.round(rate * 100);
  const clampedForRing = Math.max(0, Math.min(rate, 1)); // ring itself can't go below 0 or above full

  let color = cssVar("--income");
  let label = `${monthLabel(lastMonth)}'s savings rate`;
  if (rate < 0) {
    color = cssVar("--expense");
    label = `${monthLabel(lastMonth)}: spent more than earned`;
  } else if (rate < 0.2) {
    color = "#f59e0b";
  }

  fillEl.style.stroke = color;
  labelEl.textContent = label;

  // Animate the ring fill and the percentage text together, after layout
  // has settled (two rAFs — one to commit the 0% starting state, one to
  // trigger the CSS transition to the target offset).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fillEl.style.strokeDashoffset = `${circumference * (1 - clampedForRing)}`;
    });
  });
  countUpPercent(valueEl, displayPct);
}

function countUpPercent(el, target, duration = 900) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    el.textContent = `${value}%`;
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = `${target}%`;
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
function categoryPalette() {
  return [cssVar("--primary"), "#16a34a", "#dc2626", "#f59e0b", "#0ea5e9", "#8a5cae", "#3aa7a0"];
}

function renderCategoryChart(byCategory) {
  const ctx = document.getElementById("categoryChart");
  const palette = categoryPalette();
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([cat]) => cat);
  const values = entries.map(([, amt]) => amt);
  const total = values.reduce((s, v) => s + v, 0);

  document.getElementById("donutTotalValue").textContent = currency(total);

  if (categoryChart) { categoryChart.destroy(); categoryChart = null; }

  const legendList = document.getElementById("categoryLegendList");
  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    legendList.innerHTML = '<li class="empty-state" style="padding:10px 0;">No expenses yet.</li>';
    return;
  }

  // Animated proportion bars behind each legend row — width transitions in
  // from 0 on the next frame, after the 0%-wide starting state has painted.
  legendList.innerHTML = entries.map(([cat, amt], i) => {
    const pct = total ? Math.round((amt / total) * 100) : 0;
    return `
      <li>
        <div class="legend-row">
          <span class="legend-name"><span class="legend-dot" style="background:${palette[i % palette.length]}"></span>${escapeHtml(cat)}</span>
          <span class="legend-value">${currency(amt)}</span>
        </div>
        <span class="legend-bar-track"><span class="legend-bar-fill" data-pct="${pct}" style="background:${palette[i % palette.length]}"></span></span>
      </li>
    `;
  }).join("");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll(".legend-bar-fill").forEach((el) => {
        el.style.width = `${el.dataset.pct}%`;
      });
    });
  });

  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: palette,
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: { legend: { display: false } },
      animation: { duration: 900, easing: "easeOutQuart", animateScale: true },
    },
  });
}

function renderMonthlyBarChart(monthly) {
  const ctx = document.getElementById("monthlyBarChart");
  const labels = Object.keys(monthly).map(monthLabel);
  const income = Object.values(monthly).map((m) => m.income);
  const expense = Object.values(monthly).map((m) => m.expense);
  const gridColor = cssVar("--border");
  const tickColor = cssVar("--muted");

  if (monthlyBarChart) { monthlyBarChart.destroy(); monthlyBarChart = null; }

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  monthlyBarChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: income, backgroundColor: cssVar("--income"), borderRadius: 4, maxBarThickness: 18 },
        { label: "Expense", data: expense, backgroundColor: cssVar("--expense"), borderRadius: 4, maxBarThickness: 18 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      animation: { duration: 900, easing: "easeOutQuart", delay: (ctx) => ctx.dataIndex * 60 },
      scales: {
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
        x: { grid: { display: false }, ticks: { color: tickColor } },
      },
    },
  });
}

function renderCashflowChart(monthly) {
  const ctx = document.getElementById("cashflowChart");
  const labels = Object.keys(monthly).map(monthLabel);
  const values = Object.values(monthly).map((m) => m[cashflowMode]);
  const color = cashflowMode === "income" ? cssVar("--income") : cssVar("--expense");
  const bg = `color-mix(in srgb, ${color} 14%, transparent)`;
  const gridColor = cssVar("--border");
  const tickColor = cssVar("--muted");

  if (cashflowChart) { cashflowChart.destroy(); cashflowChart = null; }

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  cashflowChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: cashflowMode === "income" ? "Income" : "Expense",
        data: values,
        borderColor: color,
        backgroundColor: bg,
        fill: true,
        tension: 0.35,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      animation: { duration: 900, easing: "easeOutQuart" },
      scales: {
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
        x: { grid: { display: false }, ticks: { color: tickColor } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Smart insights
// ---------------------------------------------------------------------------
async function loadInsights() {
  const loading = document.getElementById("insightsLoading");
  const list = document.getElementById("insightsList");
  const empty = document.getElementById("insightsEmptyState");

  try {
    const result = await apiFetch("/api/insights");
    loading.style.display = "none";

    if (!result.has_enough_data || !result.insights.length) {
      empty.style.display = "block";
      list.innerHTML = "";
      return result;
    }

    empty.style.display = "none";
    list.innerHTML = result.insights.map((ins, i) => `
      <div class="insight-card" data-severity="${ins.severity}" style="animation-delay:${i * 90}ms">
        <div class="insight-icon">${SEVERITY_ICONS[ins.severity] || SEVERITY_ICONS.info}</div>
        <div class="insight-body">
          <div class="insight-title">${escapeHtml(ins.title)}</div>
          <div class="insight-message">${escapeHtml(ins.message)}</div>
        </div>
      </div>
    `).join("");
    return result;
  } catch (err) {
    loading.style.display = "none";
    empty.style.display = "block";
    empty.textContent = "Couldn't load insights right now — try refreshing the page.";
    return null;
  }
}
