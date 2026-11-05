/* Shared PLTheme owns the catalog; this adapter only preserves legacy page styles. */
(function () {
  'use strict';
  const root = document.documentElement;
  if (window.PLTheme?.version === 1) {
    const sync = () => root.classList.toggle('light-theme', window.PLTheme.getColorScheme() === 'light');
    sync();
    window.PLTheme.subscribe(sync);
    document.addEventListener('DOMContentLoaded', () => {
      if (document.querySelector('.pl-ui-shell')) return;
      const button = document.getElementById('theme-toggle');
      if (button) window.PLTheme.mountMenu(button);
    }, {once: true});
    return;
  }
  // A missing central asset must not leave the server-rendered page unreadable.
  // Keep an unknown saved ID intact so a temporary outage does not lose its choice.
  const key = 'pl-ui-theme';
  const valid = value => value === 'dark' || value === 'light';
  function apply(value) {
    const theme = valid(value) ? value : 'dark';
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.classList.toggle('light-theme', theme === 'light');
    window.dispatchEvent(new Event('pl-ui-theme-change'));
    return theme;
  }
  let initial = 'dark';
  try { initial = localStorage.getItem(key); } catch (_) { /* Current page still renders. */ }
  apply(initial);
  window.PLTheme = Object.freeze({
    version: 0,
    get: () => root.dataset.theme,
    set(value) {
      if (!valid(value)) return;
      apply(value);
      try { localStorage.setItem(key, value); } catch (_) { /* Browser-local best effort. */ }
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    if (button) button.addEventListener('click', () => window.PLTheme.set(window.PLTheme.get() === 'light' ? 'dark' : 'light'));
  }, {once: true});
})();
