// Wires up every ".password-field" wrapper on the page (login, signup,
// settings) to reveal/hide its password with a single eye-icon button.
// Works generically off structure, so no page-specific ids are needed here.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".password-field").forEach((wrap) => {
    const input = wrap.querySelector("input");
    const btn = wrap.querySelector(".toggle-password");
    if (!input || !btn) return;

    const eyeIcon = btn.querySelector(".eye-icon");
    const eyeOffIcon = btn.querySelector(".eye-off-icon");

    btn.addEventListener("click", () => {
      const willShow = input.type === "password";
      input.type = willShow ? "text" : "password";
      if (eyeIcon) eyeIcon.style.display = willShow ? "none" : "";
      if (eyeOffIcon) eyeOffIcon.style.display = willShow ? "" : "none";
      btn.setAttribute("aria-label", willShow ? "Hide password" : "Show password");
      // Keep focus on the field itself rather than the toggle button, so
      // typing can continue right where it left off.
      input.focus({ preventScroll: true });
    });
  });
});
