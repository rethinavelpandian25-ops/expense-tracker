// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allTransactions = [];
let modalSelectedType = "expense";
let categoryChart = null;
let trendChart = null;
let confirmCallback = null;

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
  // Section nav (sidebar + mobile bottom nav share the same data-target links)
  document.querySelectorAll("[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
      document.querySelectorAll(`.nav-link[data-target="${btn.dataset.target}"]`).forEach((l) => l.classList.add("active"));
    });
  });

  // Filters + search
  document.getElementById("filterType").addEventListener("change", renderTransactions);
  document.getElementById("filterMonth").addEventListener("change", renderTransactions);
  document.getElementById("searchInput").addEventListener("input", renderTransactions);

  // Logout
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("dropdownLogout").addEventListener("click", logout);

  // Delete account
  document.getElementById("deleteAccountBtn").addEventListener("click", confirmDeleteAccount);
  document.getElementById("dropdownDeleteAccount").addEventListener("click", confirmDeleteAccount);

  // Clear history
  document.getElementById("clearHistoryBtn").addEventListener("click", confirmClearHistory);

  // Avatar dropdown
  document.getElementById("avatarBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("avatarDropdown").classList.toggle("show");
  });
  document.addEventListener("click", () => document.getElementById("avatarDropdown").classList.remove("show"));

  // Add / edit transaction modal
  document.getElementById("addTxnOpenBtn").addEventListener("click", () => openTxnModal("add"));
  document.getElementById("mobileAddBtn").addEventListener("click", () => openTxnModal("add"));
  document.getElementById("txnModalCancel").addEventListener("click", closeTxnModal);
  document.getElementById("txnModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "txnModalOverlay") closeTxnModal();
  });
  document.getElementById("txnForm").addEventListener("submit", handleTxnSubmit);
  document.querySelectorAll("#txnModalOverlay .type-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#txnModalOverlay .type-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      modalSelectedType = btn.dataset.type;
    });
  });

  // PDF export
  document.getElementById("downloadPdfBtn").addEventListener("click", openPdfModal);
  document.getElementById("downloadPdfBtn2").addEventListener("click", openPdfModal);
  document.getElementById("pdfExportFiltered").addEventListener("click", () => { exportPdf(getFilteredTransactions(), "Current view"); closePdfModal(); });
  document.getElementById("pdfExportAll").addEventListener("click", () => { exportPdf(allTransactions, "Full history"); closePdfModal(); });
  document.getElementById("pdfModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "pdfModalOverlay") closePdfModal();
  });

  // Generic confirm modal
  document.getElementById("confirmCancel").addEventListener("click", closeConfirm);
  document.getElementById("confirmOk").addEventListener("click", async () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) await cb();
  });
  document.getElementById("confirmModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "confirmModalOverlay") closeConfirm();
  });

  // Mobile bottom nav extras
  document.getElementById("mobileSearchBtn").addEventListener("click", () => {
    document.getElementById("searchInput").scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("searchInput").focus();
  });
  document.getElementById("mobileMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("avatarDropdown").classList.toggle("show");
  });

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
  renderCategoryTiles(summary.by_category);
  renderCategoryChart(summary.by_category);
  renderTrendChart(summary.monthly);
}

async function logout() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

// ---------------------------------------------------------------------------
// Add / edit transaction modal
// ---------------------------------------------------------------------------
function openTxnModal(mode, id) {
  const form = document.getElementById("txnForm");
  form.reset();
  document.getElementById("txnId").value = "";

  if (mode === "edit") {
    const txn = allTransactions.find((t) => t.id === id);
    if (!txn) return;
    document.getElementById("txnModalTitle").textContent = "Edit transaction";
    document.getElementById("txnSubmitBtn").textContent = "Save changes";
    document.getElementById("txnId").value = txn.id;
    document.getElementById("modalCategory").value = txn.category;
    document.getElementById("modalAmount").value = txn.amount;
    document.getElementById("modalDate").value = txn.date;
    document.getElementById("modalNote").value = txn.note || "";
    modalSelectedType = txn.type;
  } else {
    document.getElementById("txnModalTitle").textContent = "Add transaction";
    document.getElementById("txnSubmitBtn").textContent = "Add transaction";
    document.getElementById("modalDate").value = todayLocalISO();
    modalSelectedType = "expense";
  }

  document.querySelectorAll("#txnModalOverlay .type-toggle button").forEach((b) => b.classList.remove("active"));
  document.querySelector(`#txnModalOverlay .type-toggle button[data-type="${modalSelectedType}"]`).classList.add("active");

  document.getElementById("txnModalOverlay").classList.add("show");
}

function closeTxnModal() {
  document.getElementById("txnModalOverlay").classList.remove("show");
}

async function handleTxnSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("txnId").value;
  const payload = {
    type: modalSelectedType,
    category: document.getElementById("modalCategory").value.trim(),
    amount: document.getElementById("modalAmount").value,
    date: document.getElementById("modalDate").value,
    note: document.getElementById("modalNote").value.trim(),
  };

  const btn = document.getElementById("txnSubmitBtn");
  btn.disabled = true;
  try {
    if (id) {
      await apiFetch(`/api/transactions/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      showToast("Transaction updated.");
    } else {
      await apiFetch("/api/transactions", { method: "POST", body: JSON.stringify(payload) });
      showToast("Transaction added.");
    }
    closeTxnModal();
    await loadEverything();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function deleteTransaction(id) {
  openConfirm("Delete transaction?", "This can't be undone.", async () => {
    try {
      await apiFetch(`/api/transactions/${id}`, { method: "DELETE" });
      showToast("Transaction deleted.");
      await loadEverything();
    } catch (err) {
      showToast(err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Clear history / delete account
// ---------------------------------------------------------------------------
function confirmClearHistory() {
  if (!allTransactions.length) {
    showToast("No transactions to clear.");
    return;
  }
  openConfirm(
    "Clear all transactions?",
    `This permanently deletes all ${allTransactions.length} transaction${allTransactions.length === 1 ? "" : "s"}. This cannot be undone.`,
    async () => {
      try {
        await apiFetch("/api/transactions/clear", { method: "DELETE" });
        showToast("All transactions deleted.");
        await loadEverything();
      } catch (err) {
        showToast(err.message);
      }
    }
  );
}

function confirmDeleteAccount() {
  openConfirm(
    "Delete your account?",
    "This permanently deletes your account and all transaction history. This cannot be undone.",
    async () => {
      try {
        await apiFetch("/api/account", { method: "DELETE" });
      } catch (err) {
        showToast(err.message);
        return;
      }
      window.location.href = "/login";
    }
  );
}

// ---------------------------------------------------------------------------
// Generic confirm modal
// ---------------------------------------------------------------------------
function openConfirm(title, message, onConfirm) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  confirmCallback = onConfirm;
  document.getElementById("confirmModalOverlay").classList.add("show");
}

function closeConfirm() {
  document.getElementById("confirmModalOverlay").classList.remove("show");
  confirmCallback = null;
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------
function openPdfModal() {
  if (!allTransactions.length) {
    showToast("No transactions to export.");
    return;
  }
  document.getElementById("pdfModalOverlay").classList.add("show");
}

function closePdfModal() {
  document.getElementById("pdfModalOverlay").classList.remove("show");
}

function exportPdf(rows, scopeLabel) {
  if (!rows.length) {
    showToast("Nothing to export in that view.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const income = rows.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = rows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  // jsPDF's built-in fonts don't reliably render the ₹ glyph, so PDF output
  // uses "Rs." instead of the on-screen ₹ symbol to avoid garbled text.
  const rs = (n) => "Rs. " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  doc.setFontSize(16);
  doc.text("Ledger — Transaction Report", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`${scopeLabel} · Generated ${new Date().toLocaleDateString()} · ${rows.length} transactions`, 14, 25);
  doc.setTextColor(20);
  doc.setFontSize(11);
  doc.text(`Income: ${rs(income)}    Expense: ${rs(expense)}    Net: ${rs(income - expense)}`, 14, 33);

  doc.autoTable({
    startY: 40,
    head: [["Date", "Type", "Category", "Note", "Amount"]],
    body: rows.map((t) => [
      formatDate(t.date),
      t.type,
      t.category,
      t.note || "-",
      (t.type === "income" ? "+" : "-") + rs(t.amount),
    ]),
    headStyles: { fillColor: [124, 58, 237] },
    styles: { fontSize: 9 },
  });

  doc.save(`ledger-transactions-${todayLocalISO()}.pdf`);
}

// ---------------------------------------------------------------------------
// Rendering: category tiles
// ---------------------------------------------------------------------------
function renderCategoryTiles(byCategory) {
  const wrap = document.getElementById("categoryTiles");
  const palette = ["#7c3aed", "#16a34a", "#f59e0b", "#0ea5e9", "#e11d48", "#8b5cf6"];
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3);

  if (!entries.length) {
    wrap.innerHTML = '<div class="empty-state">No expenses yet — add a transaction to see your top categories.</div>';
    return;
  }

  wrap.innerHTML = entries.map(([cat, amt], i) => `
    <div class="tile">
      <div class="tile-icon" style="background:${palette[i % palette.length]}">${escapeHtml(cat.charAt(0).toUpperCase())}</div>
      <div class="tile-info">
        <div class="tile-value amount">${currency(amt)}</div>
        <div class="tile-label">${escapeHtml(cat)}</div>
      </div>
    </div>
  `).join("");
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
  const q = document.getElementById("searchInput").value.trim().toLowerCase();

  return allTransactions.filter((t) => {
    if (type && t.type !== type) return false;
    if (month && !t.date.startsWith(month)) return false;
    if (q) {
      const haystack = `${t.category} ${t.note || ""} ${t.amount}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
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
  emptyState.textContent = allTransactions.length
    ? "No transactions match your search or filters."
    : "No transactions yet — add your first one above.";

  tbody.innerHTML = txns.map((t) => `
    <tr>
      <td>${formatDate(t.date)}</td>
      <td><span class="stamp ${t.type}">${t.type === "income" ? "IN" : "OUT"}</span></td>
      <td>${escapeHtml(t.category)}</td>
      <td>${escapeHtml(t.note) || "—"}</td>
      <td class="amount ${t.type}">${t.type === "income" ? "+" : "−"}${currency(t.amount)}</td>
      <td class="row-actions">
        <button class="edit-btn" onclick="openTxnModal('edit', ${t.id})">Edit</button>
        <button class="delete-btn" onclick="deleteTransaction(${t.id})">Delete</button>
      </td>
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
      <div class="row-actions" style="justify-content:flex-end;">
        <button class="edit-btn" onclick="openTxnModal('edit', ${t.id})">Edit</button>
        <button class="delete-btn" onclick="deleteTransaction(${t.id})">Delete</button>
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

  if (categoryChart) { categoryChart.destroy(); categoryChart = null; }

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
        backgroundColor: ["#7c3aed", "#16a34a", "#dc2626", "#f59e0b", "#0ea5e9", "#8a5cae", "#3aa7a0"],
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

  if (trendChart) { trendChart.destroy(); trendChart = null; }

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Income", data: income, borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,0.12)", fill: true, tension: 0.35, pointRadius: 3 },
        { label: "Expense", data: expense, borderColor: "#dc2626", backgroundColor: "rgba(220,38,38,0.12)", fill: true, tension: 0.35, pointRadius: 3 },
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
