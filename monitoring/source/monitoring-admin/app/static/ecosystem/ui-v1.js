/* Shared framework-independent PL UI. Runs as a classic script or a side-effect module. */
(function (global) {
  'use strict';
  if (!global || (global.PLUI && global.PLUI.version === 1)) return;

  var KEY = 'pl-ui-sidebar-collapsed';
  var EVENT = 'pl-ui-sidebar-change';
  var fallback = false;
  var nextShellId = 0;
  var doc = global.document;
  function stored() {
    try {
      var value = global.localStorage.getItem(KEY);
      if (value !== null) fallback = value === 'true';
    } catch (_) { /* private browsing or disabled storage */ }
    return fallback;
  }
  var sidebar = Object.freeze({
    get: stored,
    set: function (value) {
      fallback = !!value;
      try { global.localStorage.setItem(KEY, String(fallback)); } catch (_) { /* keep in memory */ }
      global.dispatchEvent(new CustomEvent(EVENT, { detail: { collapsed: fallback } }));
      return fallback;
    },
    subscribe: function (listener) {
      function onChange(event) {
        if (event.type === 'storage') {
          if (event.key !== KEY && event.key !== null) return;
          fallback = event.newValue === 'true';
        } else {
          fallback = !!(event.detail && event.detail.collapsed);
        }
        listener(fallback);
      }
      global.addEventListener(EVENT, onChange);
      global.addEventListener('storage', onChange);
      return function () {
        global.removeEventListener(EVENT, onChange);
        global.removeEventListener('storage', onChange);
      };
    }
  });
  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(paths, size) {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) { var path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.appendChild(path); });
    return svg;
  }
  function buttonClasses(options) {
    options = options || {};
    var variant = options.variant || 'secondary';
    var variants = { secondary: 'button-secondary', 'default': 'button-primary', ghost: 'button-ghost', destructive: 'button-danger' };
    var sizes = { 'default': '', sm: 'button-sm', icon: 'button-icon' };
    return ['button', 'pl-ui-button', variants[variant] || variants.secondary,
      'pl-ui-button-' + (variants[variant] ? variant : 'secondary'), sizes[options.size || 'default'] || '',
      options.size === 'sm' || options.size === 'icon' ? 'pl-ui-button-' + options.size : '', options.className || ''].filter(Boolean).join(' ');
  }
  function makeButton(label, paths, size) {
    var button = el('button', buttonClasses({ variant: 'ghost', size: 'icon' }));
    button.type = 'button'; button.setAttribute('aria-label', label); button.title = label;
    if (paths) button.appendChild(icon(paths, size));
    return button;
  }
  function createBrand(options) {
    options = options || {};
    var brand = el('a', 'brand pl-ui-brand'); brand.href = options.platformHref || '/';
    var branding = options.branding || {};
    brand.setAttribute('aria-label', branding.label || 'Platform');
    if (options.onPlatformNavigate) brand.addEventListener('click', function (event) { navigatePlatform(options, event); });
    var mark = el('span', 'brand-mark pl-ui-brand-mark'); mark.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 4; i++) mark.appendChild(el('span'));
    var words = el('span', 'pl-ui-brand-words'); words.appendChild(el('strong', '', branding.name || 'PL')); words.appendChild(el('small', '', branding.subtitle || 'PLATFORM'));
    brand.appendChild(mark); brand.appendChild(words);
    return brand;
  }
  function navigatePlatform(options, event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    options.onPlatformNavigate(event);
  }
  function createShell(options) {
    options = options || {};
    var withSidebar = options.sidebar !== false;
    var root = el('div', 'app-shell pl-ui-shell' + (withSidebar ? '' : ' pl-ui-shell-no-sidebar') + (options.wide ? ' pl-ui-shell-wide' : ''));
    root.dataset.plUi = '1';
    var navigation = el('nav', 'pl-ui-navigation'); navigation.id = options.navigationId || 'pl-ui-navigation-' + (++nextShellId); navigation.setAttribute('aria-label', 'Основная навигация');
    var sidebarFooter = el('div', 'sidebar-bottom pl-ui-sidebar-footer');
    var collapse;
    if (withSidebar) {
      var aside = el('aside', 'sidebar pl-ui-sidebar');
      var brandArea = el('div', 'sidebar-brand pl-ui-sidebar-brand');
      brandArea.appendChild(createBrand(options));
      collapse = makeButton('Свернуть меню', ['m15 18-6-6 6-6'], 16);
      collapse.classList.add('pl-ui-sidebar-toggle'); collapse.setAttribute('aria-controls', navigation.id);
      brandArea.appendChild(collapse); aside.appendChild(brandArea);
      aside.appendChild(navigation); aside.appendChild(sidebarFooter); root.appendChild(aside);
    }
    var body = el('div', 'app-body pl-ui-app-body');
    var header = el('header', 'topbar pl-ui-topbar');
    var mobileMenu, scrim;
    if (withSidebar) {
      mobileMenu = makeButton('Открыть меню', ['M4 6h16', 'M4 12h16', 'M4 18h16'], 22);
      mobileMenu.classList.add('mobile-menu', 'pl-ui-mobile-menu'); mobileMenu.setAttribute('aria-controls', navigation.id);
      mobileMenu.setAttribute('aria-expanded', 'false');
      scrim = el('button', 'mobile-scrim pl-ui-mobile-scrim'); scrim.type = 'button'; scrim.setAttribute('aria-label', 'Закрыть меню');
      function closeMobile() { root.classList.remove('mobile-nav-open'); mobileMenu.setAttribute('aria-expanded', 'false'); }
      mobileMenu.addEventListener('click', function () { root.classList.add('mobile-nav-open'); mobileMenu.setAttribute('aria-expanded', 'true'); });
      scrim.addEventListener('click', closeMobile);
      header.appendChild(mobileMenu); root.appendChild(scrim);
    }
    if (!withSidebar) header.appendChild(createBrand(options));
    var breadcrumb = el('span', 'breadcrumb pl-ui-breadcrumb');
    var platformLink = el('a', '', 'Платформа'); platformLink.href = options.platformHref || '/';
    if (options.onPlatformNavigate) platformLink.addEventListener('click', function (event) { navigatePlatform(options, event); });
    breadcrumb.appendChild(platformLink);
    var separator = icon(['m9 18 6-6-6-6'], 13); separator.classList.add('pl-ui-breadcrumb-separator');
    var current = el('strong', 'pl-ui-context'); breadcrumb.appendChild(separator); breadcrumb.appendChild(current);
    header.appendChild(breadcrumb);
    var actions = el('div', 'pl-ui-header-actions'); header.appendChild(actions);
    var user = el('div', 'user-info pl-ui-user-info');
    var avatar = el('span', 'avatar pl-ui-avatar'); avatar.setAttribute('aria-hidden', 'true');
    var identity = el('span', 'pl-ui-identity'); var name = el('strong'); var subtitle = el('small');
    identity.appendChild(name); identity.appendChild(subtitle); user.appendChild(avatar); user.appendChild(identity); header.appendChild(user);
    var logout = makeButton('Выйти', ['M10 17l5-5-5-5', 'M15 12H3', 'M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6'], 17);
    logout.classList.add('pl-ui-logout');
    var logoutDisabled = false;
    var logoutPending = false;
    logout.hidden = typeof options.onLogout !== 'function';
    logout.addEventListener('click', function (event) {
      if (typeof options.onLogout !== 'function' || logout.disabled) return;
      actionError.hidden = true;
      logoutPending = true; logout.disabled = true;
      var result;
      try { result = options.onLogout(event); }
      catch (error) { showLogoutError(); return; }
      Promise.resolve(result).then(function () { logoutPending = false; logout.disabled = logoutDisabled; }, showLogoutError);
    });
    function showLogoutError() {
      logoutPending = false; logout.disabled = logoutDisabled;
      actionError.textContent = 'Не удалось выйти. Повторите действие.'; actionError.hidden = false;
    }
    header.appendChild(logout);
    var theme = makeButton('Выбрать тему', null, 19); theme.classList.add('theme-toggle', 'pl-ui-theme-toggle');
    header.appendChild(theme); body.appendChild(header);
    var banner = el('div', 'pl-ui-banner-slot');
    var actionError = el('div', 'pl-ui-alert pl-ui-action-error'); actionError.hidden = true; actionError.setAttribute('role', 'alert');
    var main = el('main', 'pl-ui-main'); main.id = options.mainId || 'main-content';
    var footer = el('footer', 'app-footer pl-ui-footer-slot'); var overlays = el('div', 'pl-ui-overlays-slot');
    body.appendChild(banner); body.appendChild(actionError); body.appendChild(main); body.appendChild(footer); body.appendChild(overlays); root.appendChild(body);
    function setContext(text) { current.textContent = text || ''; separator.toggleAttribute('hidden', !text); current.hidden = !text; }
    function setUser(value) {
      value = value || {}; var display = typeof value.name === 'string' ? value.name.trim() : '';
      name.textContent = display; subtitle.textContent = value.subtitle || '';
      avatar.textContent = display ? Array.from(display)[0].toUpperCase() : '';
      user.hidden = !display;
    }
    function renderCollapsed(value) {
      if (!withSidebar) return;
      root.classList.toggle('sidebar-collapsed', value);
      collapse.title = value ? 'Развернуть меню' : 'Свернуть меню';
      collapse.setAttribute('aria-label', collapse.title); collapse.setAttribute('aria-expanded', String(!value));
      collapse.replaceChildren(icon(value ? ['m9 18 6-6-6-6'] : ['m15 18-6-6 6-6'], 16));
    }
    var unsubscribe = function () {};
    if (withSidebar) {
      renderCollapsed(sidebar.get()); unsubscribe = sidebar.subscribe(renderCollapsed);
      collapse.addEventListener('click', function () {
        var value = sidebar.set(!root.classList.contains('sidebar-collapsed'));
        if (typeof options.onCollapsedChange === 'function') options.onCollapsedChange(value);
      });
    }
    setContext(options.context); setUser(options.user);
    var unmountTheme = function () {};
    if (global.PLTheme && typeof global.PLTheme.mountMenu === 'function') {
      var cleanup = global.PLTheme.mountMenu(theme);
      if (typeof cleanup === 'function') unmountTheme = cleanup;
    } else {
      theme.disabled = true;
    }
    var destroyed = false;
    return {
      element: root, slots: { navigation: navigation, sidebarFooter: sidebarFooter, breadcrumb: breadcrumb, actions: actions, main: main, banner: banner, footer: footer, overlays: overlays },
      setUser: setUser, setContext: setContext,
      setLogoutDisabled: function (value) { logoutDisabled = !!value; logout.disabled = logoutDisabled || logoutPending; },
      destroy: function () { if (destroyed) return; destroyed = true; unsubscribe(); unmountTheme(); root.remove(); }
    };
  }
  global.PLUI = Object.freeze({ version: 1, createShell: createShell, createBrand: createBrand, buttonClasses: buttonClasses, sidebar: sidebar });
})(typeof window !== 'undefined' ? window : undefined);
