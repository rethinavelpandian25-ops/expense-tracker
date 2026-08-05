// Shared submit handler for the login and signup forms.
function setupAuthForm({ formId, endpoint, submitId, submitLabel, onSuccess, validate }) {
  const form = document.getElementById(formId);
  const errorBanner = document.getElementById("errorBanner");
  const submitBtn = document.getElementById(submitId);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.classList.remove("show");

    const payload = Object.fromEntries(new FormData(form).entries());

    // Optional client-side check (e.g. minimum age) so the person gets
    // instant feedback without a round trip — the server still re-checks
    // everything, so this is a convenience, not the source of truth.
    if (typeof validate === "function") {
      const validationError = validate(payload);
      if (validationError) {
        errorBanner.textContent = validationError;
        errorBanner.classList.add("show");
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Please wait…";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }

      onSuccess(data);
    } catch (err) {
      errorBanner.textContent = err.message;
      errorBanner.classList.add("show");
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  });
}
