// Actual static Inventory UI and central PL assets; only the API data is synthetic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, webkit } from '../../../monitoring/source/it-portal/frontend/node_modules/playwright/index.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const ecosystem = fileURLToPath(new URL('../../../monitoring/source/it-portal/frontend/public/ecosystem/', import.meta.url));
const keys = ['sources','questions','coverage','software','office','windows','licensing','priority','catalogPriority','sections','attempts','servers','virtualization','developerReferences'];
const empty = () => ({ ...Object.fromEntries(keys.map(key => [key, []])), summary: { rawMissing: 0, directMissing: 0 } });
const populated = () => ({ ...empty(), sources: [{ branch: 'Тестовый филиал', name: 'owned-fixture.xlsx', generated: '2026-11-05T00:00:00Z' }], softwareTotal: 1 });
const record = { branch: 'Тестовый филиал', canonical: 'ad:test', machine: 'TEST-PC', product: 'Test Application', version: '1.0', publisher: 'Example', bucket: 'Другое ПО', scope: 'Machine', architecture: 'x64', details: {}, source: 'owned-fixture.zip', sourceTable: 'software.csv', sourceRow: 2 };
let authenticated = true, missingStyles = false, styleDelay = 0, logoutFails = false;
let data = empty(), invalidPage = false, softwareFails = false, softwareHangs = false, logoutCsrf;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
  const json = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (url.pathname === '/inventory/api/session') return json(authenticated ? 200 : 401, authenticated ? { user: { id: 'owned-user', name: 'Тестовый пользователь', admin: false }, csrf_token: 'owned-inventory-token' } : { error: 'unauthorized' });
  if (url.pathname === '/api/v1/session') return json(200, { authenticated: true, csrf_token: 'owned-platform-token' });
  if (url.pathname === '/auth/logout') { logoutCsrf = request.headers['x-csrf-token']; return json(logoutFails ? 503 : 200, {}); }
  if (url.pathname === '/inventory/api/data') return json(200, { page: 1, next_page: invalidPage ? 1 : null, revision: 'a'.repeat(64), dataset: data });
  if (url.pathname === '/inventory/api/software') {
    if (softwareHangs) return;
    return json(softwareFails ? 503 : 200, softwareFails ? { message: 'Источник временно недоступен' } : { rows: [record], total: 1, machine_count: 1, page: 1, limit: 25, options: { categories: ['Другое ПО'], machines: [{ value: 'Тестовый филиал|ad:test', label: 'TEST-PC' }], versions: ['1.0'] } });
  }
  if (url.pathname === '/inventory/api/imports') return json(200, { imports: [] });
  if (url.pathname === '/ecosystem/ui-v1.css') {
    if (missingStyles) { response.writeHead(404).end(); return; }
    if (styleDelay) await new Promise(resolve => setTimeout(resolve, styleDelay));
  }
  const central = url.pathname.startsWith('/ecosystem/');
  const root = central ? ecosystem : web;
  const relative = central ? url.pathname.slice(11) : url.pathname.startsWith('/inventory/static/') ? url.pathname.slice(18) : 'index.html';
  const target = path.resolve(root, relative);
  if (!target.startsWith(root)) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { 'content-type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html' }).end(await readFile(target)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await (process.env.PL_INVENTORY_BROWSER === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }));
after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function page(options = {}) {
  const result = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  result.setDefaultTimeout(12000);
  if (options.clock) await result.clock.install();
  await result.goto(origin + '/inventory/', { waitUntil: 'domcontentloaded' });
  return result;
}
const visibleApp = page => page.locator('#app-shell:not([hidden])').waitFor();

test('authenticated empty Inventory uses PL shell, native dialogs and shared themes', async () => {
  const p = await page();
  try {
    await visibleApp(p);
    assert.equal(await p.locator('.pl-ui-brand').innerText(), 'PL\nPLATFORM');
    await p.getByText('Тестовый пользователь', { exact: true }).waitFor();
    await p.getByRole('heading', { name: 'Данные филиалов ещё не загружены' }).waitFor();
    await p.getByRole('button', { name: 'Загрузить комплект', exact: true }).click();
    assert(await p.locator('#import-dialog').isVisible());
    await p.getByRole('button', { name: 'Закрыть загрузку', exact: true }).click();
    for (const [width, height] of [[1920, 1080], [3440, 1440]]) {
      await p.setViewportSize({ width, height });
      for (const theme of ['light', 'dark', 'night']) {
        await p.evaluate(value => window.PLTheme.set(value), theme);
        assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), theme);
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await p.locator('.pl-ui-topbar').evaluate(element => Math.round(element.getBoundingClientRect().height)), 79);
      }
    }
    await p.getByRole('button', { name: 'Свернуть меню' }).click();
    await p.reload(); await visibleApp(p);
    await p.getByRole('button', { name: 'Развернуть меню' }).waitFor();
    assert.equal(await p.locator('.sidebar-footer').first().isVisible(), false);
    assert.equal(await p.evaluate(() => window.PLTheme.get()), 'night');
    if (process.env.PL_UI_REVIEW_IMAGE) await p.screenshot({ path: process.env.PL_UI_REVIEW_IMAGE });
  } finally { await p.close(); }
});

test('software pagination keeps previous results on failure and supports an explicit retry', async () => {
  data = populated(); const p = await page();
  try {
    await visibleApp(p); await p.getByRole('tab', { name: 'Всё ПО', exact: true }).click();
    await p.getByRole('button', { name: 'Test Application', exact: true }).waitFor();
    softwareFails = true; await p.locator('#search').fill('changed');
    await p.getByText('Источник временно недоступен', { exact: false }).waitFor();
    assert(await p.getByRole('button', { name: 'Test Application', exact: true }).isVisible());
    softwareFails = false; await p.getByRole('button', { name: 'Повторить', exact: true }).click();
    await p.waitForFunction(() => document.getElementById('software-status').hidden);
    assert.match(await p.locator('#results').innerText(), /Найдено записей: 1/);
  } finally { data = empty(); softwareFails = false; await p.close(); }
});

test('a hanging software read reaches a finite retry state', async () => {
  data = populated(); softwareHangs = true; const p = await page({ clock: true });
  try {
    await visibleApp(p);
    const requested = p.waitForRequest(request => request.url().includes('/inventory/api/software?'));
    await p.getByRole('tab', { name: 'Всё ПО', exact: true }).click(); await requested;
    await p.clock.fastForward(61000);
    await p.getByText('Сервер не ответил вовремя. Повторите запрос.', { exact: false }).waitFor();
    assert(await p.getByRole('button', { name: 'Повторить', exact: true }).isEnabled());
  } finally { data = empty(); softwareHangs = false; await p.close(); }
});

test('invalid bootstrap pagination fails visibly and can be retried', async () => {
  invalidPage = true; const p = await page();
  try {
    await p.getByRole('heading', { name: 'Не удалось открыть инвентаризацию' }).waitFor();
    assert.match(await p.locator('#bootstrap-message').innerText(), /неверную последовательность страниц/);
    invalidPage = false; await p.locator('#bootstrap-retry').click(); await visibleApp(p);
  } finally { invalidPage = false; await p.close(); }
});

test('expired app session retains the Platform sign-in gate', async () => {
  authenticated = false; const p = await page();
  try {
    await p.getByRole('link', { name: 'Войти через Платформу' }).waitFor();
    assert.equal(await p.locator('#app-shell').isVisible(), false);
  } finally { authenticated = true; await p.close(); }
});

test('delayed CSSOM succeeds, failed CSS retains the app and reload can recover', async () => {
  styleDelay = 500; const delayed = await page();
  try { await visibleApp(delayed); assert.equal(await delayed.locator('#pl-ui-styles').evaluate(element => Boolean(element.sheet.cssRules.length)), true); }
  finally { styleDelay = 0; await delayed.close(); }
  missingStyles = true; const p = await page();
  try {
    await visibleApp(p); assert.equal(await p.locator('.pl-ui-shell').count(), 0);
    await p.getByRole('button', { name: 'Загрузить комплект', exact: true }).click(); assert(await p.locator('#import-dialog').isVisible());
    missingStyles = false; await p.reload(); await visibleApp(p); await p.locator('.pl-ui-shell').waitFor();
  } finally { missingStyles = false; await p.close(); }
});

test('shared stylesheet timeout is bounded and leaves the original page usable', async () => {
  styleDelay = 9000; const started = Date.now(); const p = await page();
  try { await visibleApp(p); assert.equal(await p.locator('.pl-ui-shell').count(), 0); assert(Date.now() - started < 11000); }
  finally { styleDelay = 0; await p.close(); }
});

test('logout uses the Platform token and releases the button after failure', async () => {
  logoutFails = true; const p = await page();
  try {
    await visibleApp(p); const exit = p.getByRole('button', { name: 'Выйти', exact: true }); await exit.click();
    await p.getByText('Не удалось завершить сессию Платформы. Повторите выход.', { exact: false }).waitFor();
    assert.equal(logoutCsrf, 'owned-platform-token'); assert(await exit.isEnabled());
  } finally { logoutFails = false; await p.close(); }
});

test('portable runtime uses canonical PL namespaces and has no parser-blocking shared stylesheet', async () => {
  const files = ['index.html', 'shared-shell.js', 'theme-init.js', 'bootstrap.js', 'report.js', 'software-page.js', 'platform.css'];
  for (const name of files) {
    const source = await readFile(path.join(web, name), 'utf8');
    assert.doesNotMatch(source, /psk|пск|pl-ui-ui|monitoring\.[a-z-]+\.|192\.168\./i, name);
  }
  const html = await readFile(path.join(web, 'index.html'), 'utf8');
  assert(!html.includes('href="/ecosystem/ui-v1.css"'), 'shared stylesheet must be loaded by the finite loader');
  assert(!html.includes('src="/inventory/static/bootstrap.js"'), 'bootstrap must follow the loader decision');
  assert.match(await readFile(path.join(web, 'theme-init.js'), 'utf8'), /pl-ui-theme/);
});
