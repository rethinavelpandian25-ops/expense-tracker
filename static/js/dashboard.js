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
let systemAppearanceMedia = null;

// Populated server-side (see the inline script at the bottom of
// dashboard.html) so the page already knows the signed-in user without an
// extra round trip on load.
const account = window.LEDGER_USER || { username: "", email: "", profile_pic: null, theme: "purple", appearance: "system" };

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
  // Section nav — sidebar links, the mobile bottom nav, and the avatar /
  // profile-summary shortcuts all share the same data-target mechanism.
  document.querySelectorAll("[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll(".nav-link, .mobile-bottom-nav button[data-target]").forEach((l) => l.classList.remove("active"));
      document.querySelectorAll(`[data-target="${btn.dataset.target}"]`).forEach((l) => {
        if (l.classList.contains("nav-link") || l.closest(".mobile-bottom-nav")) l.classList.add("active");
      });
    });
  });

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

  // Generic confirm modal — used for delete transaction, clear history,
  // log out, and delete account, so every destructive/session-ending
  // action gets the same "are you sure?" gate.
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

  initSettings();
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

async function logout() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

function confirmLogout() {
  openConfirm("Log out?", "You'll need to sign in again to see your data.", logout);
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
// current theme + light/dark appearance (see refreshThemedVisuals below,
// called whenever either changes).
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

// Re-draws every chart + tile with the colors the newly-applied theme or
// appearance resolves to. Cheap to call — it just replays the last summary
// response through the same render functions.
function refreshThemedVisuals() {
  renderCategoryTiles(lastByCategory);
  renderCategoryChart(lastByCategory);
  renderMonthlyBarChart(lastMonthlyData);
  renderCashflowChart(lastMonthlyData);
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

// ---------------------------------------------------------------------------
// Settings — profile photo, username, password, theme, appearance, account
// ---------------------------------------------------------------------------
function initSettings() {
  renderAvatars();
  document.getElementById("settingsEmail").textContent = account.email;
  document.getElementById("sidebarUsername").textContent = account.username;
  document.getElementById("usernameInput").value = account.username;

  // Logout / delete account now live only in Settings, each behind the
  // same confirm modal used for other destructive actions.
  document.getElementById("settingsLogoutBtn").addEventListener("click", confirmLogout);
  document.getElementById("settingsDeleteBtn").addEventListener("click", confirmDeleteAccount);

  // Profile photo
  document.getElementById("profilePicInput").addEventListener("change", handleProfilePicChange);
  document.getElementById("removePhotoBtn").addEventListener("click", handleRemovePhoto);

  // Username
  document.getElementById("usernameForm").addEventListener("submit", handleUsernameSubmit);

  // Password
  document.getElementById("passwordForm").addEventListener("submit", handlePasswordSubmit);

  // Theme swatches
  const swatches = document.querySelectorAll(".theme-swatch");
  swatches.forEach((btn) => {
    if (btn.dataset.theme === account.theme) btn.classList.add("active");
    btn.addEventListener("click", () => handleThemeChange(btn.dataset.theme));
  });

  // Appearance toggle
  const appearanceButtons = document.querySelectorAll("#appearanceToggle button");
  appearanceButtons.forEach((btn) => {
    if (btn.dataset.appearanceMode === account.appearance) btn.classList.add("active");
    btn.addEventListener("click", () => handleAppearanceChange(btn.dataset.appearanceMode));
  });

  watchSystemAppearance(account.appearance);
}

function renderAvatars() {
  [
    document.getElementById("avatarBtn"),
    document.getElementById("sidebarAvatar"),
    document.getElementById("settingsAvatar"),
  ].forEach((el) => {
    if (!el) return;
    if (account.profile_pic) {
      el.innerHTML = `<img src="${account.profile_pic}" alt="Profile photo" />`;
    } else {
      el.textContent = (account.username || "?").charAt(0).toUpperCase();
    }
  });
}

function readAndCompressImage(file, maxDim = 480, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error("That photo is too large — please pick one under 8 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(canvas.toDataURL(mime, quality));
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that image."));
    reader.readAsDataURL(file);
  });
}

async function handleProfilePicChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;

  try {
    const dataUrl = await readAndCompressImage(file);
    const res = await apiFetch("/api/account/profile-picture", { method: "PUT", body: JSON.stringify({ image: dataUrl }) });
    account.profile_pic = res.profile_pic;
    renderAvatars();
    showToast("Profile photo updated.");
  } catch (err) {
    showToast(err.message);
  }
}

async function handleRemovePhoto() {
  if (!account.profile_pic) {
    showToast("No photo to remove.");
    return;
  }
  try {
    await apiFetch("/api/account/profile-picture", { method: "DELETE" });
    account.profile_pic = null;
    renderAvatars();
    showToast("Profile photo removed.");
  } catch (err) {
    showToast(err.message);
  }
}

async function handleUsernameSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("usernameInput");
  const newUsername = input.value.trim();
  if (!newUsername) return;

  try {
    const res = await apiFetch("/api/account/username", { method: "PUT", body: JSON.stringify({ username: newUsername }) });
    account.username = res.username;
    document.getElementById("sidebarUsername").textContent = account.username;
    renderAvatars();
    showToast("Username updated.");
  } catch (err) {
    showToast(err.message);
  }
}

async function handlePasswordSubmit(e) {
  e.preventDefault();
  const current = document.getElementById("currentPasswordInput");
  const next = document.getElementById("newPasswordInput");
  const confirmInput = document.getElementById("confirmPasswordInput");

  if (next.value !== confirmInput.value) {
    showToast("New passwords don't match.");
    return;
  }
  if (next.value.length < 6) {
    showToast("New password must be at least 6 characters.");
    return;
  }

  try {
    await apiFetch("/api/account/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: current.value, new_password: next.value }),
    });
    document.getElementById("passwordForm").reset();
    showToast("Password updated.");
  } catch (err) {
    showToast(err.message);
  }
}

async function handleThemeChange(theme) {
  if (theme === account.theme) return;
  account.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
  refreshThemedVisuals();
  try {
    await apiFetch("/api/account/preferences", { method: "PUT", body: JSON.stringify({ theme }) });
  } catch (err) {
    showToast(err.message);
  }
}

function resolveAppearance(mode) {
  if (mode !== "system") return mode;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppearance(mode) {
  const resolved = resolveAppearance(mode);
  document.documentElement.setAttribute("data-appearance", resolved);
  document.documentElement.setAttribute("data-appearance-mode", mode);
  try { localStorage.setItem("ledger-appearance", mode); } catch (err) { /* ignore */ }
}

function watchSystemAppearance(mode) {
  if (!window.matchMedia) return;
  if (systemAppearanceMedia) {
    systemAppearanceMedia.removeEventListener("change", handleSystemAppearanceChange);
    systemAppearanceMedia = null;
  }
  if (mode === "system") {
    systemAppearanceMedia = window.matchMedia("(prefers-color-scheme: dark)");
    systemAppearanceMedia.addEventListener("change", handleSystemAppearanceChange);
  }
}

function handleSystemAppearanceChange() {
  applyAppearance("system");
  refreshThemedVisuals();
}

async function handleAppearanceChange(mode) {
  if (mode === account.appearance) return;
  account.appearance = mode;
  applyAppearance(mode);
  document.querySelectorAll("#appearanceToggle button").forEach((b) => b.classList.toggle("active", b.dataset.appearanceMode === mode));
  watchSystemAppearance(mode);
  refreshThemedVisuals();
  try {
    await apiFetch("/api/account/preferences", { method: "PUT", body: JSON.stringify({ appearance: mode }) });
  } catch (err) {
    showToast(err.message);
  }
}
