// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allTransactions = [];
let modalSelectedType = "expense";
let confirmCallback = null;

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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();

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

  // PDF export — offers current filtered view vs. full history, since this
  // page is where the filters/search actually live.
  document.getElementById("downloadPdfBtn").addEventListener("click", openPdfModal);
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

  loadTransactions();
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
  allTransactions = await apiFetch("/api/transactions"); // no limit — the full list
  populateMonthFilter();
  renderTransactions();
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
    await loadTransactions();
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
      await loadTransactions();
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
        await loadTransactions();
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
    showToast("Nothing to export in that view.");
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
