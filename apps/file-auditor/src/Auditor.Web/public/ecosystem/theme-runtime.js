/* PLTheme v1: catalog [{id,label,colorScheme,background,icon,kind,palette}], get(): id,
 * set(id): id, getColorScheme(): light|dark, subscribe(fn(id)): unsubscribe,
 * mountMenu(button): destroy.
 * JSON palette keys become --pl-ui-theme-<kebab-case-key>; custom consumers use
 * data-pl-ui-theme-kind="custom". Load theme-catalog.js first, synchronously before CSS. */
(function () {
  'use strict';
  if (window.PLTheme && window.PLTheme.version === 1) return;
  var registry = window.PLThemeCatalog;
  var key = 'pl-ui-theme';
  var root = document.documentElement;
  if (!registry || registry.version !== 1 || !Array.isArray(registry.themes)) {
    // A missing/stale catalog must not prevent the host application from loading.
    // Preserve the stored choice so a later successful load can restore custom themes.
    var legacy = 'dark';
    try { if (window.localStorage.getItem(key) === 'light') legacy = 'light'; } catch (_) {}
    var background = legacy === 'light' ? '#edf2f7' : '#0c1522';
    root.setAttribute('data-theme', legacy);
    root.setAttribute('data-pl-ui-theme-kind', 'legacy');
    root.setAttribute('data-pl-ui-color-scheme', legacy);
    Array.from(root.style).forEach(function (token) {
      if (token.indexOf('--pl-ui-theme-') === 0) root.style.removeProperty(token);
    });
    root.style.colorScheme = legacy;
    root.style.backgroundColor = background;
    var fallbackMeta = document.querySelector('meta[name="theme-color"]');
    if (fallbackMeta) fallbackMeta.setAttribute('content', background);
    window.PLTheme = undefined;
    return;
  }
  var catalog = registry.themes.map(function (theme) {
    return Object.freeze(Object.assign({}, theme, { palette: Object.freeze(Object.assign({}, theme.palette)) }));
  });
  Object.freeze(catalog);
  var themes = new Map(catalog.map(function (theme) { return [theme.id, theme]; }));
  var defaultTheme = registry.default;
  var eventName = 'pl-ui-theme-change';
  var subscribers = new Set();
  var mounted = new WeakMap();
  var current;
  var menuSequence = 0;
  function normalize(id) { return themes.has(id) ? id : defaultTheme; }
  function read() {
    try { return normalize(window.localStorage.getItem(key)); } catch (_) { return defaultTheme; }
  }
  function apply(id) {
    var theme = themes.get(id);
    var oldTheme = themes.get(current);
    if (oldTheme) Object.keys(oldTheme.palette).forEach(function (token) {
      if (!(token in theme.palette)) root.style.removeProperty('--pl-ui-theme-' + token);
    });
    current = id;
    root.setAttribute('data-theme', id);
    root.setAttribute('data-pl-ui-theme-kind', theme.kind);
    root.setAttribute('data-pl-ui-color-scheme', theme.colorScheme);
    root.style.colorScheme = theme.colorScheme;
    root.style.backgroundColor = theme.background;
    Object.keys(theme.palette).forEach(function (token) {
      root.style.setProperty('--pl-ui-theme-' + token, theme.palette[token]);
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.background);
  }
  function notify() { subscribers.forEach(function (fn) { fn(current); }); }
  function set(id) {
    var next = normalize(id);
    try { window.localStorage.setItem(key, next); } catch (_) { /* Private/blocked storage still permits an in-page choice. */ }
    var changed = next !== current;
    apply(next);
    if (changed) {
      notify();
      window.dispatchEvent(new CustomEvent(eventName, { detail: { theme: next } }));
    }
    return next;
  }
  function subscribe(fn) {
    subscribers.add(fn);
    return function () { subscribers.delete(fn); };
  }
  window.addEventListener('storage', function (event) {
    if (event.key !== key && event.key !== null) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    var next = event.key === null ? defaultTheme : normalize(event.newValue);
    if (next === current) return;
    apply(next);
    notify();
    window.dispatchEvent(new CustomEvent(eventName, { detail: { theme: next } }));
  });
  // Preserve compatibility with callers that publish the established browser event.
  window.addEventListener(eventName, function (event) {
    var id = event.detail && (event.detail.theme || event.detail);
    if (typeof id === 'string' && normalize(id) !== current) set(id);
  });
  var paths = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42m0-14.14-1.42 1.42m-11.3 11.3-1.42 1.42"/>',
    moon: '<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/>',
    'moon-star': '<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/><path d="m18 2 .9 2.1L21 5l-2.1.9L18 8l-.9-2.1L15 5l2.1-.9Z"/>'
  };
  function icon(name) {
    return '<svg class="pl-ui-theme-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.moon) + '</svg>';
  }
  function mountMenu(button) {
    if (mounted.has(button)) return mounted.get(button);
    var originalChildren = Array.from(button.childNodes);
    var attributeNames = ['aria-label', 'title', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'type'];
    var originalAttributes = attributeNames.map(function (name) { return button.getAttribute(name); });
    var hadClass = button.classList.contains('pl-ui-theme-trigger');
    var menu = document.createElement('div');
    menu.className = 'pl-ui-theme-menu';
    menu.id = 'pl-ui-theme-menu-' + (++menuSequence);
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Тема оформления');
    menu.hidden = true;
    var items = catalog.map(function (theme) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'pl-ui-theme-option';
      item.setAttribute('role', 'menuitemradio');
      item.tabIndex = -1;
      item.innerHTML = icon(theme.icon);
      var label = document.createElement('span');
      label.textContent = theme.label;
      item.appendChild(label);
      var check = document.createElement('span');
      check.className = 'pl-ui-theme-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      item.appendChild(check);
      menu.appendChild(item);
      return item;
    });
    document.body.appendChild(menu);
    button.classList.add('pl-ui-theme-trigger');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', 'Выбрать тему');
    button.setAttribute('title', 'Выбрать тему');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id);
    var open = false;
    var openedBy = '';
    var suppressFocus = false;
    var closeTimer;
    var listeners = [];
    function listen(target, name, fn, options) {
      target.addEventListener(name, fn, options);
      listeners.push(function () { target.removeEventListener(name, fn, options); });
    }
    function cancelClose() { window.clearTimeout(closeTimer); }
    function update() {
      button.innerHTML = icon(themes.get(current).icon);
      items.forEach(function (item, index) { item.setAttribute('aria-checked', String(catalog[index].id === current)); });
    }
    function position() {
      if (!open) return;
      var rect = button.getBoundingClientRect();
      var width = menu.getBoundingClientRect().width;
      var height = menu.getBoundingClientRect().height;
      var left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      var top = rect.bottom + 8;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }
    function show(reason) {
      cancelClose();
      if (!open) {
        open = true;
        openedBy = reason;
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        position();
      }
    }
    function close(returnFocus) {
      cancelClose();
      open = false;
      openedBy = '';
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (returnFocus) {
        suppressFocus = true;
        button.focus({ preventScroll: true });
        suppressFocus = false;
      }
    }
    function laterClose() {
      cancelClose();
      if (openedBy === 'click' || openedBy === 'keyboard' || menu.contains(document.activeElement)) return;
      closeTimer = window.setTimeout(function () { close(false); }, 160);
    }
    function focusItem(index) {
      show('keyboard');
      openedBy = 'keyboard';
      items[(index + items.length) % items.length].focus();
    }
    function selectedIndex() { return catalog.findIndex(function (theme) { return theme.id === current; }); }
    listen(button, 'mouseenter', function () { show('hover'); });
    listen(button, 'mouseleave', laterClose);
    listen(menu, 'mouseenter', cancelClose);
    listen(menu, 'mouseleave', laterClose);
    listen(button, 'focus', function () { if (!suppressFocus) show('focus'); });
    listen(button, 'click', function (event) {
      event.preventDefault();
      // Focus/hover precede click; the first click must keep that newly opened menu visible.
      if (open && openedBy === 'click') close(false);
      else { show('click'); openedBy = 'click'; }
    });
    listen(button, 'keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusItem(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : selectedIndex());
      }
    });
    listen(menu, 'keydown', function (event) {
      var index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) !== -1) {
        event.preventDefault();
        focusItem(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
      }
      if (event.key === 'Tab') {
        // Return to the anchor before the browser performs its normal sequential navigation.
        close(true);
      }
    });
    items.forEach(function (item, index) {
      listen(item, 'click', function () { set(catalog[index].id); close(true); });
    });
    listen(document, 'keydown', function (event) {
      if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (open && event.key === 'Tab' && document.activeElement === button) close(false);
    });
    listen(document, 'pointerdown', function (event) {
      if (open && !button.contains(event.target) && !menu.contains(event.target)) close(false);
    });
    listen(document, 'focusin', function (event) {
      if (open && !button.contains(event.target) && !menu.contains(event.target)) close(false);
    });
    listen(window, 'resize', position);
    listen(window, 'scroll', position, true);
    var unsubscribe = subscribe(update);
    function destroy() {
      cancelClose();
      unsubscribe();
      listeners.forEach(function (remove) { remove(); });
      menu.remove();
      button.replaceChildren.apply(button, originalChildren);
      attributeNames.forEach(function (name, index) {
        if (originalAttributes[index] === null) button.removeAttribute(name);
        else button.setAttribute(name, originalAttributes[index]);
      });
      if (!hadClass) button.classList.remove('pl-ui-theme-trigger');
      mounted.delete(button);
    }
    mounted.set(button, destroy);
    update();
    close(false);
    return destroy;
  }
  apply(read());
  window.PLTheme = Object.freeze({
    version: 1, catalog: catalog, defaultTheme: defaultTheme, storageKey: key,
    get: function () { return current; },
    getColorScheme: function () { return themes.get(current).colorScheme; },
    set: set, subscribe: subscribe, mountMenu: mountMenu
  });
}());
