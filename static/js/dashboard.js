// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allTransactions = [];
let selectedType = "expense";
let categoryChart = null;
let trendChart = null;

const currency = (n) =>
  "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// input[type=date].valueAsDate reads/writes in UTC, which shows the wrong
// day for timezones ahead of UTC during early morning hours. Build the
// YYYY-MM-DD string from local date parts instead.
const todayLocalISO = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const monthLabel = (ymKey) => {
  const [y, m] = ymKey.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("default", { month: "short", year: "numeric" });
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("todayLabel").textContent = new Date().toLocaleDateString("default", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  document.getElementById("txnDate").value = todayLocalISO();

  document.querySelectorAll(".type-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".type-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedType = btn.dataset.type;
    });
  });

  document.getElementById("txnForm").addEventListener("submit", handleAddTransaction);
  document.getElementById("filterType").addEventListener("change", renderTransactions);
  document.getElementById("filterMonth").addEventListener("change", renderTransactions);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("mobileLogout").addEventListener("click", logout);

  loadEverything();
});

async function loadEverything() {
  await Promise.all([loadTransactions(), loadSummary()]);
}

// ---------------------------------------------------------------------------
// API calls
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

async function loadTransactions() {
  allTransactions = await apiFetch("/api/transactions");
  populateMonthFilter();
  renderTransactions();
}

async function loadSummary() {
  const summary = await apiFetch("/api/summary");
  document.getElementById("balanceValue").textContent = currency(summary.balance);
  document.getElementById("incomeValue").textContent = currency(summary.total_income);
  document.getElementById("expenseValue").textContent = currency(summary.total_expense);
  renderCategoryChart(summary.by_category);
  renderTrendChart(summary.monthly);
}

// ---------------------------------------------------------------------------
// Add / delete transaction
// ---------------------------------------------------------------------------
async function handleAddTransaction(e) {
  e.preventDefault();
  const btn = document.getElementById("addTxnBtn");
  const category = document.getElementById("category").value.trim();
  const amount = document.getElementById("amount").value;
  const txnDate = document.getElementById("txnDate").value;

  btn.disabled = true;
  try {
    await apiFetch("/api/transactions", {
      method: "POST",
      body: JSON.stringify({ type: selectedType, category, amount, date: txnDate }),
    });
    document.getElementById("category").value = "";
    document.getElementById("amount").value = "";
    showToast("Transaction added.");
    await loadEverything();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteTransaction(id) {
  if (!confirm("Delete this transaction?")) return;
  try {
    await apiFetch(`/api/transactions/${id}`, { method: "DELETE" });
    showToast("Transaction deleted.");
    await loadEverything();
  } catch (err) {
    showToast(err.message);
  }
}

async function logout() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

// ---------------------------------------------------------------------------
// Rendering: filters
// ---------------------------------------------------------------------------
function populateMonthFilter() {
  const select = document.getElementById("filterMonth");
  const current = select.value;
  const months = [...new Set(allTransactions.map((t) => t.date.slice(0, 7)))].sort().reverse();

  select.innerHTML = '<option value="">All months</option>' +
    months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
  select.value = current;
}

function getFilteredTransactions() {
  const type = document.getElementById("filterType").value;
  const month = document.getElementById("filterMonth").value;
  return allTransactions.filter((t) => {
    if (type && t.type !== type) return false;
    if (month && !t.date.startsWith(month)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Rendering: table + mobile cards
// ---------------------------------------------------------------------------
function renderTransactions() {
  const txns = getFilteredTransactions();
  const tbody = document.getElementById("txnTableBody");
  const cardsWrap = document.getElementById("txnCards");
  const emptyState = document.getElementById("emptyState");

  emptyState.style.display = txns.length ? "none" : "block";

  tbody.innerHTML = txns.map((t) => `
    <tr>
      <td>${formatDate(t.date)}</td>
      <td><span class="stamp ${t.type}">${t.type === "income" ? "IN" : "OUT"}</span></td>
      <td>${escapeHtml(t.category)}</td>
      <td>${escapeHtml(t.note) || "—"}</td>
      <td class="amount ${t.type}">${t.type === "income" ? "+" : "−"}${currency(t.amount)}</td>
      <td class="row-actions"><button onclick="deleteTransaction(${t.id})">Delete</button></td>
    </tr>
  `).join("");

  cardsWrap.innerHTML = txns.map((t) => `
    <div class="txn-card">
      <div class="row1">
        <span class="stamp ${t.type}">${t.type === "income" ? "IN" : "OUT"}</span>
        <span class="amount ${t.type}">${t.type === "income" ? "+" : "−"}${currency(t.amount)}</span>
      </div>
      <div class="meta">
        <span>${escapeHtml(t.category)}${t.note ? " · " + escapeHtml(t.note) : ""}</span>
        <span>${formatDate(t.date)}</span>
      </div>
      <div class="row-actions" style="text-align:right; margin-top:6px;">
        <button onclick="deleteTransaction(${t.id})">Delete</button>
      </div>
    </div>
  `).join("");
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("default", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
function renderCategoryChart(byCategory) {
  const ctx = document.getElementById("categoryChart");
  const labels = Object.keys(byCategory);
  const values = Object.values(byCategory);

  if (categoryChart) categoryChart.destroy();

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: ["#146356", "#1e8f5e", "#c0472a", "#e0a11c", "#5a6f8f", "#8a5cae", "#3aa7a0"],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        title: { display: true, text: "Spending by category", align: "start", font: { size: 13 } },
      },
    },
  });
}

function renderTrendChart(monthly) {
  const ctx = document.getElementById("trendChart");
  const labels = Object.keys(monthly).map(monthLabel);
  const income = Object.values(monthly).map((m) => m.income);
  const expense = Object.values(monthly).map((m) => m.expense);

  if (trendChart) trendChart.destroy();

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  trendChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: income, backgroundColor: "#1e8f5e" },
        { label: "Expense", data: expense, backgroundColor: "#c0472a" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        title: { display: true, text: "Last 6 months", align: "start", font: { size: 13 } },
      },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
