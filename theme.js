(() => {
  const storageKey = 'pane-theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* The theme still works when storage is unavailable. */ }

  function applyTheme() {
    const theme = preference || (systemTheme.matches ? 'dark' : 'light');
    const isDark = theme === 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = isDark ? '#151b24' : '#f4f6f8';
    const button = document.querySelector('#theme-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(isDark));
    button.title = isDark ? '라이트 모드로 전환' : '다크 모드로 전환';
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${isDark
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>'
      : '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>'}</svg>`;
  }

  // A synchronous head script applies the stored/system theme before CSS paints.
  applyTheme();
  systemTheme.addEventListener('change', () => { if (!preference) applyTheme(); });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelector('#theme-toggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(storageKey, preference); } catch { /* Keep the choice for this session. */ }
      applyTheme();
    });
  });
})();
