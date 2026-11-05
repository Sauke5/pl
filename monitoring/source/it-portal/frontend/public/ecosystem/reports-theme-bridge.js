/* Own report HTML only. Served as /ecosystem/reports-theme-bridge.js. */
(function () {
  "use strict";
  var unmountLegacyMenu;
  function mountLegacyMenu() {
    if (!window.PLTheme || !document.querySelector(".report-header")) return;
    var button = document.getElementById("theme-toggle");
    if (
      !button ||
      !document.getElementById("expand-all") ||
      !document.getElementById("collapse-all")
    )
      return;
    // Old reports retain a binary click handler closing over the original node.
    // Replace only that button so it cannot fight the shared controller.
    if (!button.classList.contains("pl-ui-theme-trigger")) {
      var clean = button.cloneNode(false);
      button.replaceWith(clean);
      button = clean;
    }
    window.PLTheme.set(window.PLTheme.get());
    unmountLegacyMenu = window.PLTheme.mountMenu(button);
  }
  function loadSharedShell() {
    var page = document.querySelector("main.page");
    var legacyTheme = document.getElementById("theme-toggle");
    if (!page || !document.querySelector(".report-header") || !legacyTheme) return;
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/ecosystem/ui-v1.css";
    css.onerror = function () { css.remove(); };
    css.onload = function () {
      var script = document.createElement("script");
      script.src = "/ecosystem/ui-v1.js";
      script.onerror = function () { script.remove(); css.remove(); };
      script.onload = function () {
        if (!window.PLUI || typeof window.PLUI.createShell !== "function") {
          script.remove(); css.remove(); return;
        }
        var shell, oldParent = page.parentNode, oldNext = page.nextSibling;
        try {
          shell = window.PLUI.createShell({ sidebar: false, context: "Отчёты", onLogout: logout });
          shell.slots.main.classList.add("pl-ui-report-main");
          page.parentNode.insertBefore(shell.element, page);
          shell.slots.main.appendChild(page);
          if (typeof unmountLegacyMenu === "function") unmountLegacyMenu();
          legacyTheme.remove();
        } catch (_) {
          if (page.parentNode !== oldParent) oldParent.insertBefore(page, oldNext);
          if (shell) shell.destroy();
          script.remove(); css.remove(); return;
        }
        var exit = shell.element.querySelector(".pl-ui-logout");
        exit.hidden = true;
        var login = document.createElement("a");
        login.href = "/"; login.textContent = "Войти";
        shell.slots.actions.appendChild(login);
        var session;
        fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (value) {
            session = value;
            var user = value && value.authenticated && value.user;
            if (!user) return;
            shell.setUser({ name: user.display_name || user.name || user.id || "Пользователь", subtitle: "Пользователь Платформы" });
            exit.hidden = false; login.hidden = true;
          }).catch(function () { /* Preserve report access when session information is unavailable. */ });
        async function logout() {
          exit.disabled = true;
          try {
            if (!session || !session.authenticated) { location.assign("/"); return; }
            var response = await fetch("/auth/logout", {
              method: "POST", credentials: "same-origin",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token || "" }, body: "{}"
            });
            if (response.ok || response.status === 401) { location.assign("/"); return; }
            throw new Error();
          } catch (_) {
            exit.disabled = false;
            var notice = document.createElement("p");
            notice.setAttribute("role", "alert");
            notice.textContent = "Не удалось завершить сеанс. Повторите выход из Платформы.";
            shell.slots.banner.replaceChildren(notice);
          }
        }
      };
      document.head.appendChild(script);
    };
    document.head.appendChild(css);
  }
  var paletteStyles;
  function loadPaletteStyles() {
    if (!paletteStyles) {
      paletteStyles = fetch("/ecosystem/reports-theme.css", {
        credentials: "same-origin",
        cache: "no-cache",
      })
        .then(function (response) {
          if (!response.ok) throw new Error("Report palette unavailable");
          return response.text();
        })
        .catch(function (error) {
          paletteStyles = undefined;
          throw error;
        });
    }
    return paletteStyles;
  }
  async function previewHTML(source) {
    if (!window.PLTheme) return source;
    var theme = window.PLTheme.catalog.find(function (item) {
      return item.id === window.PLTheme.get();
    });
    var doc = new DOMParser().parseFromString(source, "text/html");
    var root = doc.documentElement;
    root.setAttribute("data-theme", theme.id);
    root.setAttribute("data-pl-ui-theme-kind", theme.kind);
    root.setAttribute("data-pl-ui-color-scheme", theme.colorScheme);
    root.style.colorScheme = theme.colorScheme;
    Object.keys(theme.palette).forEach(function (key) {
      root.style.setProperty("--pl-ui-theme-" + key, theme.palette[key]);
    });
    var bridge = doc.createElement("style");
    try {
      bridge.textContent = await loadPaletteStyles();
    } catch {
      // Styling is optional; the original report still opens in the sandbox.
      return source;
    }
    doc.head.appendChild(bridge);
    // The caller assigns this string only to its sandbox="" iframe srcdoc.
    // It is never inserted into the parent DOM and no report script is enabled.
    return "<!doctype html>\n" + root.outerHTML;
  }
  window.PLReportTheme = Object.freeze({ previewHTML: previewHTML });
  function initialize() { mountLegacyMenu(); loadSharedShell(); }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true,
    });
  else initialize();
})();
