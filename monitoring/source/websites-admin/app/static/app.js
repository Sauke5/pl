(function () {
  'use strict';
  const progress = document.getElementById('page-progress');
  const progressLabel = document.getElementById('page-progress-label');
  const shell = document.getElementById('app-shell');
  const sidebar = document.getElementById('site-navigation');
  const sharedShell = shell?.dataset.plUi === '1';
  const mobileMenu = sharedShell ? null : document.querySelector('.mobile-menu');
  const mobileScrim = sharedShell ? null : document.querySelector('.mobile-scrim');
  const sidebarToggle = sharedShell ? null : document.querySelector('.sidebar-toggle');

  function readPreference(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function savePreference(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* Optional browser preference. */ }
  }
  function setMobileNav(open) {
    if (!shell || !sidebar || !mobileMenu) return;
    shell.classList.toggle('mobile-nav-open', open);
    mobileMenu.setAttribute('aria-expanded', String(open));
    if (mobileScrim) mobileScrim.hidden = !open;
    document.body.classList.toggle('nav-open', open);
    if (open) sidebar.querySelector('a')?.focus();
    else mobileMenu.focus();
  }
  function setSidebarCollapsed(collapsed) {
    if (!shell || !sidebarToggle) return;
    shell.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Развернуть меню' : 'Свернуть меню');
    savePreference('websites-sidebar-collapsed', String(collapsed));
  }
  if (mobileMenu) mobileMenu.addEventListener('click', () => setMobileNav(!shell.classList.contains('mobile-nav-open')));
  if (mobileScrim) mobileScrim.addEventListener('click', () => setMobileNav(false));
  if (sidebarToggle) sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!shell.classList.contains('sidebar-collapsed')));
  setSidebarCollapsed(readPreference('websites-sidebar-collapsed') === 'true');
  document.addEventListener('keydown', (event) => {
    if (sharedShell || !shell?.classList.contains('mobile-nav-open')) return;
    if (event.key === 'Escape') { setMobileNav(false); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(sidebar.querySelectorAll('a, button')).filter((item) => item.getClientRects().length);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  window.matchMedia('(max-width: 760px)').addEventListener('change', (event) => {
    if (!event.matches && shell?.classList.contains('mobile-nav-open')) setMobileNav(false);
  });

  function setProgress(active, label) {
    if (!progress) return;
    if (label && progressLabel) progressLabel.textContent = label;
    progress.classList.toggle('is-active', active);
    progress.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function formFeedback(form, message) {
    let feedback = form.querySelector('[data-form-feedback]');
    if (!feedback) {
      feedback = document.createElement('div');
      feedback.dataset.formFeedback = '1';
      feedback.className = 'notice notice-error field-error';
      feedback.setAttribute('role', 'alert');
      feedback.tabIndex = -1;
      const actions = form.querySelector('.form-actions');
      if (actions) actions.before(feedback);
      else form.append(feedback);
    }
    feedback.textContent = message;
    feedback.hidden = !message;
    if (message) feedback.focus();
  }

  const platformLogout = document.querySelector('[data-platform-logout]');
  async function logoutFromPlatform() {
    const error = document.getElementById('session-error');
    platformLogout.disabled = true;
    if (error) error.hidden = true;
    setProgress(true, 'Завершаю сеанс…');
    try {
      const session = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (session.status === 401) { window.location.assign('/'); return; }
      if (!session.ok) throw new Error('session unavailable');
      const identity = await session.json();
      if (identity.authenticated === false) { window.location.assign('/'); return; }
      if (typeof identity.csrf_token !== 'string' || !identity.csrf_token) throw new Error('missing csrf');
      const response = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'X-CSRF-Token': identity.csrf_token, 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok && response.status !== 401) throw new Error('logout failed');
      window.location.assign('/');
    } catch (_) {
      if (error) {
        error.textContent = 'Не удалось завершить сеанс Платформы. Повторите попытку.';
        error.hidden = false;
        error.scrollIntoView({ block: 'nearest' });
      }
    } finally {
      platformLogout.disabled = false;
      setProgress(false);
    }
  }
  if (platformLogout) {
    window.plWebsitesPlatformLogout = logoutFromPlatform;
    if (!platformLogout.closest?.('.pl-ui-shell')) platformLogout.addEventListener('click', logoutFromPlatform);
  }

  function initialize(scope) {
    scope.querySelectorAll('dialog').forEach((dialog) => {
      if (dialog.dataset.focusBound) return;
      dialog.dataset.focusBound = '1';
      dialog.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((item) => item.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    });
    scope.querySelectorAll('[data-history-back]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => window.history.back());
    });
    scope.querySelectorAll('[data-year]').forEach((item) => { item.textContent = String(new Date().getFullYear()); });
    scope.querySelectorAll('[data-dialog-open]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => document.getElementById(button.dataset.dialogOpen).showModal());
    });
    scope.querySelectorAll('[data-dialog-close]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => button.closest('dialog').close());
    });
    scope.querySelectorAll('[data-use-recommended]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        const form = button.closest('form');
        form.querySelectorAll('input[name="fragments"]').forEach((item) => { item.checked = item.dataset.recommended === 'true'; });
        formFeedback(form, '');
      });
    });
    scope.querySelectorAll('[data-candidate-form]').forEach((form) => {
      if (form.dataset.candidateBound) return;
      form.dataset.candidateBound = '1';
      form.addEventListener('change', (event) => {
        if (event.target.name !== 'fragments' || !event.target.checked) return;
        const checked = form.querySelectorAll('input[name="fragments"]:checked');
        if (checked.length > Number(form.dataset.max || 4)) {
          event.target.checked = false;
          formFeedback(form, `Можно выбрать не больше ${form.dataset.max || 4} фрагментов.`);
        } else {
          formFeedback(form, '');
        }
      });
    });
    scope.querySelectorAll('[data-content-toggle]').forEach((toggleInput) => {
      const form = toggleInput.closest('form');
      const candidates = form.querySelector('[data-content-candidates]');
      const update = () => {
        if (candidates) {
          candidates.hidden = !toggleInput.checked;
          candidates.querySelectorAll('input').forEach((item) => { item.disabled = !toggleInput.checked; });
        }
      };
      if (!toggleInput.dataset.bound) {
        toggleInput.dataset.bound = '1';
        toggleInput.addEventListener('change', update);
      }
      update();
    });
    scope.querySelectorAll('form[data-reason-form]').forEach((form) => {
      if (form.dataset.submitBound) return;
      form.dataset.submitBound = '1';
      const reason = form.querySelector('textarea[name="reason"]');
      const submitButton = form.querySelector('button[type="submit"]');
      const updateSubmitState = () => {
        if (submitButton && reason) submitButton.disabled = reason.value.trim().length < 3;
      };
      if (reason) {
        reason.addEventListener('input', updateSubmitState);
        updateSubmitState();
      }
      form.addEventListener('submit', (event) => {
        const selected = form.querySelectorAll('input[name="fragments"]:checked');
        const contentToggle = form.querySelector('[data-content-toggle]');
        if (form.hasAttribute('data-candidate-form') && (!contentToggle || contentToggle.checked) && selected.length === 0) {
          event.preventDefault();
          formFeedback(form, 'Выберите хотя бы один контрольный фрагмент.');
          return;
        }
        if (!form.reportValidity()) {
          event.preventDefault();
          return;
        }
        const button = submitButton;
        if (button) {
          button.disabled = true;
          button.dataset.originalText = button.textContent;
          button.textContent = 'Применяю…';
        }
        setProgress(true, form.dataset.progressLabel || 'Применяю изменения…');
      });
    });
  }

  initialize(document);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented || form.matches('[data-reason-form]')) return;
    setProgress(true, form.dataset.progressLabel || 'Загружаю данные…');
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;
    const url = new URL(link.href, window.location.href);
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    if (url.origin === window.location.origin && url.pathname.startsWith('/websites')) setProgress(true, 'Загружаю данные…');
  });
  window.addEventListener('pageshow', () => setProgress(false));
  document.body.addEventListener('htmx:beforeRequest', (event) => {
    setProgress(true, event.target.dataset.progressLabel || 'Выполняю проверку…');
    event.detail.target?.setAttribute('aria-busy', 'true');
  });
  document.body.addEventListener('htmx:afterRequest', (event) => {
    setProgress(false);
    event.detail.target?.setAttribute('aria-busy', 'false');
  });
  document.body.addEventListener('htmx:afterSwap', (event) => initialize(event.target));
  function previewError(event) {
    setProgress(false);
    const target = event.detail.target;
    if (target) {
      target.setAttribute('aria-busy', 'false');
      target.innerHTML = '<div class="notice notice-error" role="alert">Не удалось выполнить проверку. Введённые данные сохранены в форме. Повторите попытку.</div>';
    }
  }
  document.body.addEventListener('htmx:responseError', previewError);
  document.body.addEventListener('htmx:sendError', previewError);
  document.body.addEventListener('htmx:timeout', previewError);
})();
