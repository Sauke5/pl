(function () {
  if (document.documentElement.dataset.doskaMode !== "platform") return;
  if (window.PLTheme) {
    var sync = function () {
      var light = window.PLTheme.getColorScheme() === "light";
      document.documentElement.classList.toggle("dark", !light);
      document.documentElement.classList.toggle("light", light);
    };
    sync(); window.PLTheme.subscribe(sync);
    document.documentElement.lang = "ru-RU";
    return;
  }
  var theme = "dark";
  try {
    if (localStorage.getItem("pl-ui-theme") === "light") theme = "light";
  } catch (_) {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  document.documentElement.lang = "ru-RU";
  document.title = "Задачи — PL";
})();
