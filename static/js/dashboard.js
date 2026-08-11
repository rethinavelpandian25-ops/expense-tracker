// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const PREVIEW_LIMIT = 7;

let allTransactions = []; // holds only the preview (<= PREVIEW_LIMIT rows) on this page
let modalSelectedType = "expense";
let confirmCallback = null;
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

// Reads a live CSS custom property off <html> so the category tiles always
// match the current theme + light/dark appearance, instead of being baked in.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();
  setupSectionNav();

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

  // PDF export — the dashboard has no filters to choose a "current view"
  // from (that lives on the full Transactions page now), so this is a
  // single click straight to exporting everything.
  document.getElementById("downloadPdfBtn").addEventListener("click", handleDashboardPdfExport);

  // Generic confirm modal — used for deleting a transaction from the preview.
  document.getElementById("confirmCancel").addEventListener("click", closeConfirm);
  document.getElementById("confirmOk").addEventListener("click", async () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) await cb();
  });
  document.getElementById("confirmModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "confirmModalOverlay") closeConfirm();
  });

  // Supports the "Add transaction" home-screen shortcut (see
  // static/site.webmanifest) — installed Android apps can jump straight
  // into the Add form via a long-press shortcut, same as a native app.
  if (new URLSearchParams(location.search).get("action") === "add") {
    openTxnModal("add");
    history.replaceState(null, "", "/dashboard");
  }

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

// Dashboard/Reports links carry both a real href (so they work with no JS,
// in a new tab, etc.) and a data-target matching a section id on THIS page.
// When the target exists here, intercept the click for a smooth in-page
// scroll instead of a full reload. When it doesn't (e.g. arriving from
// another page), let the browser follow the href normally.
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

  // Arriving here via a link like /dashboard#charts (e.g. from the
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
  // Ask for one more than we'll show — if that extra row comes back, there
  // are more than PREVIEW_LIMIT transactions in total, so "Load more" is
  // worth showing. This avoids a separate count endpoint.
  const rows = await apiFetch(`/api/transactions?limit=${PREVIEW_LIMIT + 1}`);
  const hasMore = rows.length > PREVIEW_LIMIT;
  allTransactions = hasMore ? rows.slice(0, PREVIEW_LIMIT) : rows;
  document.getElementById("loadMoreWrap").style.display = hasMore ? "flex" : "none";
  renderTransactions();
}

async function loadSummary() {
  const summaryData = await apiFetch("/api/summary");
  document.getElementById("balanceValue").textContent = currency(summaryData.balance);
  lastByCategory = summaryData.by_category;
  renderCategoryTiles(lastByCategory);
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
// PDF export (dashboard: always the full history, no scope choice)
// ---------------------------------------------------------------------------
async function handleDashboardPdfExport() {
  const btn = document.getElementById("downloadPdfBtn");
  btn.disabled = true;
  try {
    const all = await apiFetch("/api/transactions");
    exportPdf(all, "Full history");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// Draws the transaction table using jsPDF's own core primitives (text +
// filled rects) instead of the jspdf-autotable plugin. autoTable turned out
// to be an unreliable CDN dependency in practice — several jsPDF/autotable
// version pairings are known to fail to attach doc.autoTable at all
// depending on load timing/CDN quirks. This avoids that failure mode
// entirely by not depending on the plugin.
function drawTransactionsTable(doc, rows, startY, rs) {
  const marginLeft = 14;
  const marginRight = 196; // A4 width (210mm) minus a 14mm right margin
  const tableWidth = marginRight - marginLeft;
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomMargin = 18;
  const rowHeight = 7;
  const headerHeight = 8;

  const columns = [
    { key: "date", label: "Date", x: marginLeft, width: 24 },
    { key: "type", label: "Type", x: marginLeft + 24, width: 16 },
    { key: "category", label: "Category", x: marginLeft + 40, width: 36 },
    { key: "note", label: "Note", x: marginLeft + 76, width: 62 },
  ];
  const amountColX = marginRight;

  const truncate = (str, maxChars) => {
    const s = String(str || "");
    return s.length > maxChars ? s.slice(0, maxChars - 1) + "…" : s;
  };

  let y = startY;

  function drawHeaderRow() {
    doc.setFillColor(124, 58, 237);
    doc.rect(marginLeft, y - 5.5, tableWidth, headerHeight, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont(undefined, "bold");
    doc.setFontSize(9);
    columns.forEach((col) => doc.text(col.label, col.x, y));
    doc.text("Amount", amountColX, y, { align: "right" });
    doc.setFont(undefined, "normal");
    doc.setTextColor(20, 20, 20);
    y += headerHeight;
  }

  drawHeaderRow();

  rows.forEach((row, i) => {
    if (y > pageHeight - bottomMargin) {
      doc.addPage();
      y = 20;
      drawHeaderRow();
    }
    if (i % 2 === 1) {
      doc.setFillColor(247, 246, 252);
      doc.rect(marginLeft, y - 5, tableWidth, rowHeight, "F");
    }
    doc.setFontSize(8.5);
    doc.setTextColor(20, 20, 20);
    doc.text(formatDate(row.date), columns[0].x, y);
    doc.text(row.type === "income" ? "Income" : "Expense", columns[1].x, y);
    doc.text(truncate(row.category, 20), columns[2].x, y);
    doc.text(truncate(row.note || "-", 34), columns[3].x, y);
    doc.setTextColor(row.type === "income" ? 22 : 200, row.type === "income" ? 163 : 40, row.type === "income" ? 74 : 40);
    doc.text((row.type === "income" ? "+" : "-") + rs(row.amount), amountColX, y, { align: "right" });
    y += rowHeight;
  });

  return y;
}

function exportPdf(rows, scopeLabel) {
  if (!rows.length) {
    showToast("No transactions to export.");
    return;
  }

  // jsPDF loads from a CDN — if a connection hiccup, an ad blocker, or a
  // corporate firewall stopped it from loading, window.jspdf simply won't
  // exist. Fail with a clear message instead of a silent no-op click.
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    showToast("Couldn't load the PDF tool — check your connection and reload the page.");
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

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

    drawTransactionsTable(doc, rows, 44, rs);

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
// Rendering: recent-transactions preview (table + mobile cards)
// ---------------------------------------------------------------------------
function renderTransactions() {
  const tbody = document.getElementById("txnTableBody");
  const cardsWrap = document.getElementById("txnCards");
  const emptyState = document.getElementById("emptyState");

  emptyState.style.display = allTransactions.length ? "none" : "block";

  tbody.innerHTML = allTransactions.map((t) => `
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

  cardsWrap.innerHTML = allTransactions.map((t) => `
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
