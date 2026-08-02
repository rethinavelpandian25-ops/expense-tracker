// Shared submit handler for the login and signup forms.
function setupAuthForm({ formId, endpoint, submitId, submitLabel, onSuccess }) {
  const form = document.getElementById(formId);
  const errorBanner = document.getElementById("errorBanner");
  const submitBtn = document.getElementById(submitId);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.classList.remove("show");

    const payload = Object.fromEntries(new FormData(form).entries());

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
