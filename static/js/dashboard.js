// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allTransactions = [];
let modalSelectedType = "expense";
let categoryChart = null;
let monthlyBarChart = null;
let cashflowChart = null;
let confirmCallback = null;
let cashflowMode = "income";
let lastMonthlyData = {};
let lastByCategory = {};

// Populated server-side (see the inline script in app_shell.html) so the
// page already knows the signed-in user without an extra round trip.
const account = window.LEDGER_USER || { username: "", profile_pic: null };

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

// Reads a live CSS custom property off <html> so chart colors always match
// the current theme + light/dark appearance, instead of being baked in.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();
  setupSectionNav();

  // Filters + search
  document.getElementById("filterType").addEventListener("change", renderTransactions);
  document.getElementById("filterMonth").addEventListener("change", renderTransactions);
  document.getElementById("searchInput").addEventListener("input", renderTransactions);

  // Clear history
  document.getElementById("clearHistoryBtn").addEventListener("click", confirmClearHistory);

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

  // PDF export — one entry point (the balance card button); it opens a
  // modal offering the export scope rather than two separate buttons.
  document.getElementById("downloadPdfBtn").addEventListener("click", openPdfModal);
  document.getElementById("pdfExportFiltered").addEventListener("click", () => { exportPdf(getFilteredTransactions(), "Current view"); closePdfModal(); });
  document.getElementById("pdfExportAll").addEventListener("click", () => { exportPdf(allTransactions, "Full history"); closePdfModal(); });
  document.getElementById("pdfModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "pdfModalOverlay") closePdfModal();
  });

  // Generic confirm modal — used for delete transaction and clear history.
  document.getElementById("confirmCancel").addEventListener("click", closeConfirm);
  document.getElementById("confirmOk").addEventListener("click", async () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) await cb();
  });
  document.getElementById("confirmModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "confirmModalOverlay") closeConfirm();
  });

  // Cashflow toggle
  document.querySelectorAll(".pill-btn[data-cashflow]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pill-btn[data-cashflow]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      cashflowMode = btn.dataset.cashflow;
      renderCashflowChart(lastMonthlyData);
    });
  });

  // Mobile bottom nav extras
  document.getElementById("mobileSearchBtn").addEventListener("click", () => {
    document.getElementById("history").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("searchInput").focus();
  });

  loadEverything();
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

// Dashboard/Transactions/Reports links carry both a real href (so they work
// with no JS, in a new tab, etc.) and a data-target matching a section id
// on THIS page. When the target exists here, intercept the click for a
// smooth in-page scroll instead of a full reload. When it doesn't (e.g. the
// Settings page linking back to a dashboard section), let the browser
// follow the href normally — that's how cross-page nav still works with
// zero extra code.
function setupSectionNav() {
  document.querySelectorAll("[data-target]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const target = document.getElementById(el.dataset.target);
      if (!target) return; // not on this page — let the link navigate normally
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", `#${el.dataset.target}`);
      document.querySelectorAll(".nav-link, .mobile-bottom-nav [data-target]").forEach((l) => l.classList.remove("active"));
      document.querySelectorAll(`[data-target="${el.dataset.target}"]`).forEach((l) => {
        if (l.classList.contains("nav-link") || l.closest(".mobile-bottom-nav")) l.classList.add("active");
      });
    });
  });

  // Arriving here via a link like /dashboard#history (e.g. from the
  // Settings page) — jump to that section and mark the right nav item.
  if (location.hash) {
    const target = document.querySelector(location.hash);
    if (target) {
      requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      const key = location.hash.slice(1);
      document.querySelectorAll(".nav-link, .mobile-bottom-nav [data-target]").forEach((l) => l.classList.remove("active"));
      document.querySelectorAll(`[data-target="${key}"]`).forEach((l) => {
        if (l.classList.contains("nav-link") || l.closest(".mobile-bottom-nav")) l.classList.add("active");
      });
    }
  }
}

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
  const summaryData = await apiFetch("/api/summary");
  document.getElementById("balanceValue").textContent = currency(summaryData.balance);
  document.getElementById("reportIncomeValue").textContent = currency(summaryData.total_income);
  document.getElementById("reportExpenseValue").textContent = currency(summaryData.total_expense);
  lastMonthlyData = summaryData.monthly;
  lastByCategory = summaryData.by_category;

  renderCategoryTiles(lastByCategory);
  renderCategoryChart(lastByCategory);
  renderMonthlyBarChart(lastMonthlyData);
  renderCashflowChart(lastMonthlyData);
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
// Clear history
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

  // jsPDF/autotable load from a CDN — if a connection hiccup, an ad
  // blocker, or a corporate firewall stopped either script from loading,
  // window.jspdf (or doc.autoTable) simply won't exist. Fail with a clear
  // message instead of a silent no-op click.
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    showToast("Couldn't load the PDF tool — check your connection and reload the page.");
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    if (typeof doc.autoTable !== "function") {
      showToast("Couldn't load the PDF table tool — check your connection and reload the page.");
      return;
    }

    const income = rows.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = rows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

    // jsPDF's built-in fonts only reliably render plain ASCII, so PDF
    // output avoids ₹, —, and · in favor of "Rs.", "-", and "|" — this
    // keeps every PDF viewer/printer rendering it correctly.
    const rs = (n) => "Rs. " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    doc.setFontSize(16);
    doc.text("Ledger - Transaction Report", 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`${scopeLabel} | Generated ${new Date().toLocaleDateString()} | ${rows.length} transactions`, 14, 25);
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
  } catch (err) {
    console.error("PDF export failed:", err);
    showToast("Couldn't generate the PDF. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Rendering: category tiles
// ---------------------------------------------------------------------------
function renderCategoryTiles(byCategory) {
  const wrap = document.getElementById("categoryTiles");
  const palette = tilePalette();
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
// Charts — colors are read live from CSS variables so they always match the
// current theme + light/dark appearance chosen in Settings.
// ---------------------------------------------------------------------------
function tilePalette() {
  return [cssVar("--primary"), "#16a34a", "#f59e0b", "#0ea5e9", "#e11d48", "#8b5cf6"];
}

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

  legendList.innerHTML = entries.map(([cat, amt], i) => `
    <li>
      <span class="legend-name"><span class="legend-dot" style="background:${palette[i % palette.length]}"></span>${escapeHtml(cat)}</span>
      <span class="legend-value">${currency(amt)}</span>
    </li>
  `).join("");

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
      scales: {
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
        x: { grid: { display: false }, ticks: { color: tickColor } },
      },
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
