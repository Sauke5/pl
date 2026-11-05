(function () {
  var theme = 'dark';
  try {
    var storage = window.localStorage;
    var value = storage.getItem('pl-ui-theme');
    if (value === null) {
      var legacy = storage.getItem('wayline-theme');
      if (legacy === 'dark' || legacy === 'light') {
        value = legacy;
        try { storage.setItem('pl-ui-theme', legacy); } catch (_) {}
      }
    }
    if (value === 'light') theme = 'light';
  } catch (_) {}
  document.documentElement.dataset.theme = theme;
})();
