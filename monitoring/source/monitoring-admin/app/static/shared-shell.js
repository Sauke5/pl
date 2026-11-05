/* Enhance the server-rendered shell when the shared UI is available. */
(function () {
  'use strict';
  var source = document.querySelector('.app-shell:not(.auth-app)');
  var nav = source && source.querySelector('.sidebar-nav');
  var main = source && source.querySelector('#main-content');
  var form = source && source.querySelector('#logout-form');
  if (!source || !nav || !main || !form || !window.PLUI || typeof window.PLUI.createShell !== 'function') return;

  function enhance() {
    var name = source.querySelector('.user-label');
    var subtitle = source.querySelector('.user-info small');
    var gateway = document.querySelector('meta[name="auth-mode"]')?.content === 'gateway';
    var shared = window.PLUI.createShell({
      context: 'Мониторинг', navigationId: 'admin-sidebar',
      user: {name: name ? name.textContent.trim() : '', subtitle: subtitle ? subtitle.textContent.trim() : ''},
      onLogout: function () {
        if (gateway) return window.plMonitoringPlatformLogout();
        shared.setLogoutDisabled(true);
        try { form.requestSubmit(); }
        catch (error) { shared.setLogoutDisabled(false); throw error; }
      },
      onCollapsedChange: function () { window.dispatchEvent(new Event('resize')); }
    });
    if (gateway) shared.setLogoutDisabled(typeof window.plMonitoringPlatformLogout !== 'function');
    window.addEventListener('pageshow', function (event) { if (!gateway && event.persisted) shared.setLogoutDisabled(false); });
    shared.slots.navigation.classList.add('sidebar-nav');
    shared.slots.navigation.setAttribute('aria-label', 'Разделы управления');
    shared.slots.navigation.append.apply(shared.slots.navigation, Array.from(nav.childNodes));
    var status = source.querySelector('.sidebar-foot');
    if (status) {
      status.classList.add('pl-ui-sidebar-caption', 'pl-ui-sidebar-status');
      shared.slots.sidebarFooter.appendChild(status);
    }
    shared.slots.main.id = 'main-content';
    shared.slots.main.classList.add('main-content');
    shared.slots.main.append.apply(shared.slots.main, Array.from(main.childNodes));
    var footer = source.querySelector('footer');
    if (footer) shared.slots.footer.appendChild(footer);
    form.hidden = true;
    shared.slots.overlays.appendChild(form);
    source.replaceWith(shared.element);
    window.plMonitoringShell = shared;
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
