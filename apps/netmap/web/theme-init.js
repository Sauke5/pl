// Apply the Platform preference before CSS, including when storage is unavailable.
(() => {
  if (window.PLTheme) {
    document.addEventListener('DOMContentLoaded',() => {
      const toggle=document.getElementById('theme-toggle');
      if(toggle)toggle._plThemeUnmount=window.PLTheme.mountMenu(toggle);
    });
    return;
  }
  function apply(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.style.backgroundColor = theme === 'light' ? '#edf2f7' : '#0c1522';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',root.style.backgroundColor);
    const toggle = document.getElementById('theme-toggle');
    if (toggle) { toggle.setAttribute('aria-label',theme === 'light' ? 'Тёмная тема' : 'Светлая тема'); toggle.title = theme === 'light' ? 'Тёмная тема' : 'Светлая тема'; }
  }
  let current = 'dark';
  try { current = localStorage.getItem('pl-ui-theme') || 'dark'; } catch {}
  apply(current);
  window.addEventListener('storage',event => { if(event.key === 'pl-ui-theme') apply(event.newValue); });
  document.addEventListener('DOMContentLoaded',() => {
    apply(document.documentElement.dataset.theme);
    document.getElementById('theme-toggle')?.addEventListener('click',() => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem('pl-ui-theme',next); } catch {}
      apply(next);
    });
  });
})();
