function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function activeTheme() {
  const explicitTheme = document.documentElement.dataset.theme;
  if (explicitTheme === "light" || explicitTheme === "dark") return explicitTheme;
  return systemPrefersDark() ? "dark" : "light";
}

export function setupTheme() {
  const button = document.querySelector(".theme-toggle");
  if (!button) return;

  try {
    const storedTheme = localStorage.getItem("theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      document.documentElement.dataset.theme = storedTheme;
    }
  } catch (_) {}

  button.setAttribute("aria-pressed", String(activeTheme() === "dark"));
  button.addEventListener("click", () => {
    const nextTheme = activeTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    button.setAttribute("aria-pressed", String(nextTheme === "dark"));
    try {
      localStorage.setItem("theme", nextTheme);
    } catch (_) {}
  });
}

setupTheme();
