// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let confirmCallback = null;
let systemAppearanceMedia = null;

// Populated server-side (see the inline script in app_shell.html) so the
// page already knows the signed-in user without an extra round trip.
const account = window.LEDGER_USER || { username: "", email: "", profile_pic: null, theme: "purple", appearance: "system", country: "India", currency_code: "INR", currency_symbol: "₹", currency_locale: "en-IN" };

const COUNTRY_CURRENCIES = {
  "India": ["INR","₹","en-IN"], "United States":["USD","$","en-US"], "United Kingdom":["GBP","£","en-GB"],
  "European Union":["EUR","€","en-IE"], "Canada":["CAD","CA$","en-CA"], "Australia":["AUD","A$","en-AU"],
  "Singapore":["SGD","S$","en-SG"], "United Arab Emirates":["AED","د.إ","en-AE"], "Japan":["JPY","¥","ja-JP"],
  "China":["CNY","¥","zh-CN"], "South Korea":["KRW","₩","ko-KR"], "New Zealand":["NZD","NZ$","en-NZ"],
  "Switzerland":["CHF","CHF","de-CH"], "South Africa":["ZAR","R","en-ZA"], "Brazil":["BRL","R$","pt-BR"]
};

document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();
  document.getElementById("settingsEmail").textContent = account.email;
  document.getElementById("usernameInput").value = account.username;
  document.getElementById("usernameDisplay").textContent = account.username;

  document.getElementById("settingsLogoutBtn").addEventListener("click", confirmLogout);
  document.getElementById("settingsDeleteBtn").addEventListener("click", confirmDeleteAccount);

  document.getElementById("profilePicInput").addEventListener("change", handleProfilePicChange);
  document.getElementById("removePhotoBtn").addEventListener("click", handleRemovePhoto);

  document.getElementById("usernameForm").addEventListener("submit", handleUsernameSubmit);
  document.getElementById("passwordForm").addEventListener("submit", handlePasswordSubmit);
  document.getElementById("editUsernameBtn").addEventListener("click", beginUsernameEdit);
  document.getElementById("cancelUsernameBtn").addEventListener("click", cancelUsernameEdit);
  initCountrySelect();

  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    if (btn.dataset.theme === account.theme) btn.classList.add("active");
    btn.addEventListener("click", () => handleThemeChange(btn.dataset.theme));
  });

  document.querySelectorAll("#appearanceToggle button").forEach((btn) => {
    if (btn.dataset.appearanceMode === account.appearance) btn.classList.add("active");
    btn.addEventListener("click", () => handleAppearanceChange(btn.dataset.appearanceMode));
  });
  watchSystemAppearance(account.appearance);

  document.getElementById("confirmCancel").addEventListener("click", closeConfirm);
  document.getElementById("confirmOk").addEventListener("click", async () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) await cb();
  });
  document.getElementById("confirmModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "confirmModalOverlay") closeConfirm();
  });
});

// ---------------------------------------------------------------------------
// API helper
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

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
function renderAvatars() {
  [document.getElementById("sidebarAvatar"), document.getElementById("settingsAvatar")].forEach((el) => {
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

// ---------------------------------------------------------------------------
// Username / password
// ---------------------------------------------------------------------------
function beginUsernameEdit() {
  document.getElementById("usernameView").style.display = "none";
  document.getElementById("usernameForm").style.display = "flex";
  const input = document.getElementById("usernameInput");
  input.value = account.username; input.focus(); input.select();
}

function cancelUsernameEdit() {
  document.getElementById("usernameForm").style.display = "none";
  document.getElementById("usernameView").style.display = "flex";
  document.getElementById("usernameInput").value = account.username;
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
    document.getElementById("usernameDisplay").textContent = account.username;
    renderAvatars();
    cancelUsernameEdit();
    showToast("Username updated.");
  } catch (err) { showToast(err.message); }
}

function initCountrySelect() {
  const select = document.getElementById("countrySelect");
  if (!select) return;
  select.innerHTML = Object.keys(COUNTRY_CURRENCIES).map(c => `<option value="${c}">${c}</option>`).join("");
  select.value = account.country || "India";
  updateCurrencyPreview();
  select.addEventListener("change", handleCountryChange);
}

function updateCurrencyPreview() {
  const el = document.getElementById("currencyPreview");
  if (!el) return;
  el.textContent = `Currency: ${account.currency_code} (${account.currency_symbol}) · Example: ${account.currency_symbol}1,234.56`;
}

async function handleCountryChange(e) {
  const country = e.target.value;
  const [code, symbol, locale] = COUNTRY_CURRENCIES[country];
  try {
    const res = await apiFetch("/api/account/preferences", { method:"PUT", body:JSON.stringify({ country }) });
    account.country = country; account.currency_code = res.currency_code || code; account.currency_symbol = res.currency_symbol || symbol; account.currency_locale = res.currency_locale || locale;
    updateCurrencyPreview();
    showToast(`Currency changed to ${account.currency_code}.`);
  } catch (err) { e.target.value = account.country || "India"; showToast(err.message); }
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

// ---------------------------------------------------------------------------
// Theme / appearance
// ---------------------------------------------------------------------------
async function handleThemeChange(theme) {
  if (theme === account.theme) return;
  account.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
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
}

async function handleAppearanceChange(mode) {
  if (mode === account.appearance) return;
  account.appearance = mode;
  applyAppearance(mode);
  document.querySelectorAll("#appearanceToggle button").forEach((b) => b.classList.toggle("active", b.dataset.appearanceMode === mode));
  watchSystemAppearance(mode);
  try {
    await apiFetch("/api/account/preferences", { method: "PUT", body: JSON.stringify({ appearance: mode }) });
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Logout / delete account
// ---------------------------------------------------------------------------
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
