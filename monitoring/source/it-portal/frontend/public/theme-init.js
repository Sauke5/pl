// Compatibility bootstrap when the common controller is unavailable.
(function () {
  if (window.PLTheme) return;
  var id = "dark";
  try { id = localStorage.getItem("pl-ui-theme") || id; } catch (_) {}
  var catalog = window.PLThemeCatalog;
  var theme = catalog && catalog.version === 1 && Array.isArray(catalog.themes)
    ? catalog.themes.find(function (item) { return item.id === id; }) : null;
  var root = document.documentElement;
  if (theme) {
    root.dataset.theme = theme.id;
    root.dataset.plUiThemeKind = theme.kind;
    root.dataset.plUiColorScheme = theme.colorScheme;
    root.style.colorScheme = theme.colorScheme;
    root.style.backgroundColor = theme.background;
    Object.keys(theme.palette).forEach(function (token) {
      root.style.setProperty("--pl-theme-" + token, theme.palette[token]);
    });
  } else {
    root.dataset.theme = id === "light" ? "light" : "dark";
    root.dataset.plUiThemeKind = "legacy";
    root.dataset.plUiColorScheme = root.dataset.theme;
    root.style.colorScheme = root.dataset.theme;
    root.style.backgroundColor = id === "light" ? "#edf2f7" : "#0c1522";
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", root.style.backgroundColor);
})();
