import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {chromium, webkit} from '../../it-portal/frontend/node_modules/playwright/index.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reportFile = 'infrastructure-2026-11-01-run-1.html';
const report = '<!doctype html><html><head><title>Synthetic report</title></head><body><h1>Synthetic report</h1><script>parent.__reportScriptRan = true;</script></body></html>';
let missing = '', logoutRequests = 0;
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://fixture').pathname;
  if (req.method === 'POST') {
    assert.equal(p, '/auth/logout');
    assert.equal(req.headers['x-csrf-token'], 'test-csrf');
    logoutRequests++;
    res.writeHead(503).end();
    return;
  }
  if (p === '/api/v1/session') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({authenticated: true, user: {name: 'Fixture user', admin: true}, csrf_token: 'test-csrf'}));
    return;
  }
  if (p === '/reports/reports.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{report_type: 'daily', date: '2026-11-01', run: 1, file: reportFile}]));
    return;
  }
  if (p === '/reports/' + reportFile) {
    res.setHeader('Content-Type', 'text/html'); res.end(report); return;
  }
  if (p === '/reports/legacy.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta charset="utf-8"><script src="/ecosystem/theme-catalog.js"></script><script src="/ecosystem/theme-runtime.js"></script><link rel="stylesheet" href="/ecosystem/theme-menu.css"><script src="/ecosystem/reports-theme-bridge.js"></script></head><body><main class="page"><header class="report-header"><h1>Legacy report</h1><button id="theme-toggle">Theme</button><button id="expand-all">Expand</button><button id="collapse-all">Collapse</button></header><details><summary>Section</summary>Report content</details></main></body></html>');
    return;
  }
  let file;
  if (p === '/reports/') file = resolve(source, 'nginx/index.html');
  else if (p.startsWith('/ecosystem/')) {
    const name = p.split('/').pop();
    if (!['theme-catalog.js', 'theme-runtime.js', 'theme-menu.css', 'ui-v1.js', 'ui-v1.css', 'reports-theme.css', 'reports-theme-bridge.js'].includes(name)) {res.writeHead(404).end(); return;}
    if (name === missing) {res.writeHead(404).end(); return;}
    file = resolve(source, name.startsWith('reports-theme') ? 'nginx' : 'it-portal/frontend/public/ecosystem', name);
  } else {res.writeHead(404).end(); return;}
  try {
    const content = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(content);
  } catch {res.writeHead(404).end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const useWebKit = process.env.PL_ADMIN_BROWSER === 'webkit';
const browser = await (useWebKit ? webkit : chromium).launch(useWebKit ? {headless: true} : {headless: true, channel: 'chrome'});
after(async () => {await browser.close(); await new Promise(r => server.close(r));});
async function pageFor(path) {
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base + path);
  return page;
}

test('Reports uses PL shell and preserves archive, theme/reload, sandbox preview and logout failure', async () => {
  const page = await pageFor('/reports/');
  try {
    await page.locator('.pl-ui-shell').waitFor();
    await page.getByText('Fixture user', {exact: true}).waitFor();
    assert.equal(await page.locator('.pl-ui-sidebar').count(), 0);
    for (const width of [1920, 3440]) {
      await page.setViewportSize({width, height: 1440});
      for (const theme of ['light', 'dark', 'night']) {
        await page.evaluate(value => window.PLTheme.set(value), theme);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    await page.reload();
    await page.locator('.pl-ui-shell').waitFor();
    assert.equal(await page.evaluate(() => window.PLTheme.get()), 'night');
    await page.locator('#archive-rows tr').first().waitFor();
    await page.locator('#archive-rows .action-preview').first().click();
    await page.locator('#preview-backdrop:not(.hidden)').waitFor();
    assert.equal(await page.locator('#preview-frame').getAttribute('sandbox'), '');
    await page.frameLocator('#preview-frame').getByRole('heading', {name: 'Synthetic report'}).waitFor();
    assert.equal(await page.evaluate(() => window.__reportScriptRan), undefined);
    assert.match(await page.locator('#preview-frame').getAttribute('srcdoc'), /data-pl-ui-theme-kind="custom"/);
    await page.keyboard.press('Escape');
    await page.locator('#preview-backdrop').waitFor({state: 'hidden'});
    const before = logoutRequests;
    await page.getByRole('button', {name: 'Выйти', exact: true}).click();
    await page.locator('#manifest-state').filter({hasText: 'Не удалось завершить сеанс'}).waitFor();
    assert.equal(logoutRequests, before + 1);
    assert.equal(await page.getByRole('button', {name: 'Выйти', exact: true}).isEnabled(), true);
    assert.equal(new URL(page.url()).pathname, '/reports/');
  } finally {await page.close();}
});

for (const asset of ['ui-v1.js', 'ui-v1.css']) test(`Reports missing ${asset} retains usable archive and theme`, async () => {
  missing = asset;
  const page = await pageFor('/reports/');
  try {
    assert.equal(await page.locator('.pl-ui-shell').count(), 0);
    await page.getByRole('heading', {name: 'Отчёты инфраструктуры'}).waitFor();
    await page.locator('#archive-rows tr').first().waitFor();
    await page.getByRole('button', {name: 'Выбрать тему'}).click();
    await page.getByRole('menuitemradio', {name: 'Хэллоуин'}).click();
    assert.equal(await page.evaluate(() => window.PLTheme.get()), 'night');
  } finally {missing = ''; await page.close();}
});

test('Legacy report bridge uses shared PL shell without losing report controls', async () => {
  const page = await pageFor('/reports/legacy.html');
  try {
    await page.locator('.pl-ui-shell').waitFor();
    await page.getByText('Fixture user', {exact: true}).waitFor();
    await page.getByRole('button', {name: 'Expand', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Collapse', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Выйти', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'Не удалось завершить сеанс'}).waitFor();
    assert.equal(await page.getByRole('heading', {name: 'Legacy report'}).isVisible(), true);
  } finally {await page.close();}
});
