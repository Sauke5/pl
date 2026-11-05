/* Keep the existing page as a functional fallback if shared assets cannot load. */
(function () {
  'use strict';
  const source = document.getElementById('app-shell');
  const nav = source?.querySelector('.tabs');
  const main = source?.querySelector('main');
  const start = async () => {
    if (!source || !nav || !main) return false;
    const style = document.createElement('link');
    style.id = 'pl-ui-styles'; style.rel = 'stylesheet'; style.href = '/ecosystem/ui-v1.css';
    const script = document.createElement('script'); script.src = '/ecosystem/ui-v1.js'; script.async = true;
    function loaded(element) {
      return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); element.removeEventListener('load', ready); element.removeEventListener('error', failed); };
        const failed = () => { cleanup(); reject(new Error('Shared asset unavailable')); };
        const ready = () => {
          let usable = element !== style;
          if (element === style) { try { usable = Boolean(style.sheet?.cssRules.length); } catch (_) { usable = false; } }
          cleanup(); usable ? resolve() : reject(new Error('Shared stylesheet unavailable'));
        };
        element.addEventListener('load', ready, { once: true });
        element.addEventListener('error', failed, { once: true });
        timer = setTimeout(failed, 8000);
        document.head.appendChild(element);
      });
    }
    try { await Promise.all([loaded(style), loaded(script)]); }
    catch (_) { style.remove(); script.remove(); return false; }
    if (!window.PLUI?.createShell) { style.remove(); return false; }

  const paths = {
    licensing:'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
    software:'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    priority:'m12 3 2.7 5.5L21 9.4l-4.5 4.4L17.5 20 12 17l-5.5 3 1-6.2L3 9.4l6.3-.9z',
    windows:'M3 5 11 4v7H3z M13 4l8-1v8h-8z M3 13h8v7l-8-1z M13 13h8v8l-8-1z',
    office:'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
    coverage:'M4 19V9 M10 19V5 M16 19v-7 M22 19H2',
    questions:'M4 5h16v12H8l-4 3z M8 9h8 M8 13h6'
  };
  nav.querySelectorAll('[data-view]').forEach(button => {
    const label=button.querySelector('span')?.textContent.trim() || button.dataset.view;
    button.setAttribute('aria-label',label); button.title=label;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('width','19'); svg.setAttribute('height','19');
    svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','1.6');
    svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round'); svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',paths[button.dataset.view] || paths.software); svg.appendChild(path); button.prepend(svg);
  });
  const shared=window.PLUI.createShell({branding:{name:'PL',subtitle:'PLATFORM',label:'Platform'},context:'Инвентаризация ПО', navigationId:'inventory-navigation',onLogout:()=>window.plInventoryLogout()});
  shared.element.id='app-shell'; shared.element.hidden=source.hidden;
  shared.slots.navigation.classList.add('tabs');
  shared.slots.navigation.setAttribute('role','tablist');
  shared.slots.navigation.setAttribute('aria-label','Разделы инвентаризации');
  shared.slots.navigation.setAttribute('aria-orientation','vertical');
  shared.slots.navigation.append(...Array.from(nav.childNodes));
  const footer=source.querySelector('.sidebar-footer');
  if(footer) shared.slots.sidebarFooter.appendChild(footer);
  shared.slots.main.append(...Array.from(main.childNodes));
  shared.element.querySelector('.pl-ui-theme-toggle').id='theme-toggle';
  shared.element.querySelector('.pl-ui-logout').id='logout-button';
  shared.element.querySelector('.pl-ui-identity strong').id='current-user-name';
  for(const id of ['details-dialog','import-dialog','history-dialog']) {
    const dialog=document.getElementById(id);
    if(dialog) shared.slots.overlays.appendChild(dialog);
  }
  source.replaceWith(shared.element);
  window.plInventoryShell=shared;
  return true;
  };
  window.plInventoryShellReady = start().catch(() => false);
  // A stylesheet inserted by one defer script can block subsequent defer
  // scripts in browsers. Load the existing app assets after the finite shell
  // decision so a failed stylesheet cannot postpone bootstrap indefinitely.
  const loadApplicationScript = path => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = path;
    const timer = setTimeout(() => { script.remove(); reject(new Error('Application asset unavailable')); }, 8000);
    script.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    script.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Application asset unavailable')); }, { once: true });
    document.head.appendChild(script);
  });
  window.plInventoryShellReady.then(async () => {
    await loadApplicationScript('/inventory/static/report.js');
    await loadApplicationScript('/inventory/static/bootstrap.js');
  }).catch(() => {
    document.getElementById('bootstrap-title').textContent = 'Не удалось открыть инвентаризацию';
    document.getElementById('bootstrap-message').textContent = 'Не удалось загрузить интерфейс. Перезагрузите страницу.';
    const retry = document.getElementById('bootstrap-retry');
    retry.hidden = false; retry.addEventListener('click', () => location.reload(), { once: true });
  });
})();
