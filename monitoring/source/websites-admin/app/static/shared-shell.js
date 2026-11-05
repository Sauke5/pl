/* Enhance the authenticated server-rendered shell when the shared UI is available. */
(function () {
  'use strict';
  var source = document.getElementById('app-shell');
  var nav = source && source.querySelector('#site-navigation nav');
  var main = source && source.querySelector('#main-content');
  var identity = source && source.querySelector('.user-info');
  if (!source || !nav || !main || !identity || !window.PLUI || typeof window.PLUI.createShell !== 'function') return;

  function enhance() {
    var oldLogout = source.querySelector('[data-platform-logout]');
    var form = source.querySelector('.header-actions form');
    var name = identity.querySelector('strong');
    var subtitle = identity.querySelector('small');
    var shared = window.PLUI.createShell({
      context: source.querySelector('.breadcrumb strong')?.textContent.trim() || 'Сайты',
      navigationId: 'site-navigation',
      user: {name: name ? name.textContent.trim() : '', subtitle: subtitle ? subtitle.textContent.trim() : ''},
      onLogout: function () {
        if (!form) return window.plWebsitesPlatformLogout();
        shared.setLogoutDisabled(true);
        try { form.requestSubmit(); }
        catch (error) { shared.setLogoutDisabled(false); throw error; }
      }
    });
    window.addEventListener('pageshow', function (event) { if (event.persisted) shared.setLogoutDisabled(false); });
    shared.element.id = 'app-shell';
    shared.slots.navigation.setAttribute('aria-label', 'Навигация сервиса');
    shared.slots.navigation.append.apply(shared.slots.navigation, Array.from(nav.childNodes));
    var divider = shared.slots.navigation.querySelector('.nav-divider');
    if (divider) divider.classList.add('divider');
    var caption = source.querySelector('.sidebar-footer');
    if (caption) caption.classList.add('pl-ui-sidebar-caption');
    var bottom = source.querySelector('.sidebar-bottom');
    if (bottom) shared.slots.sidebarFooter.append.apply(shared.slots.sidebarFooter, Array.from(bottom.childNodes));
    shared.slots.main.id = 'main-content';
    shared.slots.main.tabIndex = -1;
    shared.slots.main.append.apply(shared.slots.main, Array.from(main.childNodes));
    if (oldLogout) shared.element.querySelector('.pl-ui-logout').setAttribute('data-platform-logout', '');
    if (form) { form.hidden = true; shared.slots.overlays.appendChild(form); }
    source.replaceWith(shared.element);
  }
  var link = document.getElementById('pl-ui-styles');
  function stylesAvailable() {
    try { return Boolean(link?.sheet?.cssRules.length); } catch (_) { return false; }
  }
  if (stylesAvailable()) { enhance(); return; }
  if (!link || document.readyState === 'complete') return;
  // WebKit may expose the stylesheet CSSOM after deferred scripts have run.
  var timer;
  function finish() {
    clearTimeout(timer);
    link.removeEventListener('load', finish);
    link.removeEventListener('error', finish);
    window.removeEventListener('load', finish);
    if (stylesAvailable()) enhance();
  }
  link.addEventListener('load', finish, {once:true});
  link.addEventListener('error', finish, {once:true});
  window.addEventListener('load', finish, {once:true});
  timer = setTimeout(finish, 8000);
  if (stylesAvailable() || document.readyState === 'complete') finish();
})();
