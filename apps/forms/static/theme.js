(() => {
  if (window.PLTheme) return;
  const apply = value => { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'; };
  try { apply(localStorage.getItem('pl-ui-theme')); } catch { apply('dark'); }
  addEventListener('storage', event => { if (event.key === 'pl-ui-theme') apply(event.newValue); });
})();
