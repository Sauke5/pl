// Run: node --test tests/unit/theme-runtime.test.cjs (uses the existing Playwright dev dependency).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const assets = path.join(__dirname, '../../public/ecosystem');
const runtime = readFileSync(path.join(assets, 'theme-runtime.js'), 'utf8');
const catalog = JSON.parse(readFileSync(path.join(assets, 'theme-catalog.json'), 'utf8'));
const css = readFileSync(path.join(assets, 'theme-menu.css'), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.PL_TEST_BROWSER_CHANNEL ? { channel: process.env.PL_TEST_BROWSER_CHANNEL } : {}) }); });
after(async () => { if (browser) await browser.close(); });
async function setup(registry = catalog, stored = null) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.route('http://theme.test/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="theme-color" content="#000"><button id="theme" style="position:absolute;right:20px;top:20px;width:34px;height:34px">old</button><button id="after" style="position:absolute;right:300px;top:100px">Next</button>' }));
  await page.goto('http://theme.test/');
  await page.evaluate(({ registry, stored }) => {
    window.PLThemeCatalog = registry;
    if (stored !== null) localStorage.setItem('pl-ui-theme', stored);
  }, { registry, stored });
  await page.addScriptTag({ content: runtime });
  await page.addStyleTag({ content: css });
  return page;
}
test('missing/404 and incompatible catalog preserve legacy bootstrap without page errors', async () => {
  for (const failure of ['missing-404', 'incompatible']) {
    for (const stored of ['light', 'dark', 'night', 'unknown-theme']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.route('http://theme.test/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="theme-color"><button id="theme">Theme</button>' }));
        await page.route('http://theme.test/theme-catalog.js', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }));
        await page.goto('http://theme.test/');
        await page.evaluate(({ stored, failure, registry }) => {
          localStorage.setItem('pl-ui-theme', stored);
          const root = document.documentElement;
          root.dataset.theme = 'night';
          root.dataset.plUiThemeKind = 'custom';
          root.style.setProperty('--pl-ui-theme-text', '#abcdef');
          root.style.setProperty('--unrelated-token', 'keep');
          if (failure === 'incompatible') window.PLThemeCatalog = { ...registry, version: 2 };
        }, { stored, failure, registry: catalog });
        if (failure === 'missing-404') await page.addScriptTag({ url: 'http://theme.test/theme-catalog.js' }).catch(() => {});
        await page.addScriptTag({ content: runtime });
        const legacy = stored === 'light' ? 'light' : 'dark';
        assert.deepEqual(await page.evaluate(() => {
          // The guarded control adapter can expose an unavailable picker as disabled.
          document.querySelector('#theme').disabled = !window.PLTheme?.mountMenu;
          const root = document.documentElement;
          return [typeof window.PLTheme, root.dataset.theme, root.dataset.plUiThemeKind,
            root.dataset.plUiColorScheme, root.style.colorScheme, document.querySelector('meta').content,
            root.style.getPropertyValue('--pl-ui-theme-text'), root.style.getPropertyValue('--unrelated-token'),
            localStorage.getItem('pl-ui-theme'), document.querySelector('#theme').disabled];
        }), ['undefined', legacy, 'legacy', legacy, legacy, legacy === 'light' ? '#edf2f7' : '#0c1522', '', 'keep', stored, true], failure + ': ' + stored);
        assert.deepEqual(errors, [], failure + ': ' + stored);
      } finally { await context.close(); }
    }
  }
});
test('boot, persistence, shared event, storage removal, and unsubscribe', async () => {
  const page = await setup(catalog, 'night');
  try {
    assert.deepEqual(await page.evaluate(() => [PLTheme.get(), document.documentElement.dataset.plUiThemeKind, PLTheme.getColorScheme(), document.documentElement.dataset.plUiColorScheme, document.documentElement.style.colorScheme, document.querySelector('meta').content]), ['night', 'custom', 'dark', 'dark', 'dark', '#100e16']);
    assert.deepEqual(await page.evaluate(() => {
      const seen = [];
      const unsubscribe = PLTheme.subscribe(id => seen.push(id));
      PLTheme.set('light');
      unsubscribe();
      PLTheme.set('dark');
      window.dispatchEvent(new CustomEvent('pl-ui-theme-change', { detail: { theme: 'night' } }));
      return [seen, PLTheme.get(), localStorage.getItem('pl-ui-theme')];
    }), [['light'], 'night', 'night']);
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'pl-ui-theme', newValue: null })));
    assert.equal(await page.evaluate(() => PLTheme.get()), 'dark');
  } finally { await page.context().close(); }
});
test('real same-origin tabs propagate storage changes', async () => {
  const page = await setup();
  const other = await page.context().newPage();
  try {
    await other.route('http://theme.test/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="theme-color">' }));
    await other.goto('http://theme.test/service-two/');
    await other.evaluate(registry => { window.PLThemeCatalog = registry; }, catalog);
    await other.addScriptTag({ content: runtime });
    await other.evaluate(() => PLTheme.set('night'));
    await page.waitForFunction(() => PLTheme.get() === 'night');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.plUiThemeKind), 'custom');
    await page.evaluate(() => PLTheme.set('light'));
    await other.waitForFunction(() => PLTheme.get() === 'light');
  } finally { await other.close(); await page.context().close(); }
});
test('arbitrary registry custom palette works without a new hardcoded id', async () => {
  const extended = structuredClone(catalog);
  extended.themes.push({ ...structuredClone(catalog.themes[2]), id: 'graphite-next', label: 'Новая', palette: { ...catalog.themes[2].palette, text: '#abcdef' } });
  const page = await setup(extended, 'graphite-next');
  try {
    assert.deepEqual(await page.evaluate(() => [PLTheme.get(), document.documentElement.dataset.plUiThemeKind, document.documentElement.style.getPropertyValue('--pl-ui-theme-text')]), ['graphite-next', 'custom', '#abcdef']);
    await page.evaluate(() => PLTheme.mountMenu(document.querySelector('#theme')));
    assert.equal(await page.getByRole('menuitemradio', { includeHidden: true }).count(), 4);
    assert.equal(await page.evaluate(() => PLTheme.set('unknown-theme')), 'dark');
  } finally { await page.context().close(); }
});
test('hover then click stays open, selection closes and focus return does not reopen', async () => {
  const page = await setup();
  try {
    const before = await page.locator('#theme').boundingBox();
    await page.evaluate(() => { window.destroyMenu = PLTheme.mountMenu(document.querySelector('#theme')); });
    assert.deepEqual(await page.locator('#theme').boundingBox(), before);
    await page.locator('#theme').hover();
    assert.equal(await page.getByRole('menu').isVisible(), true);
    await page.locator('#theme').click();
    assert.equal(await page.getByRole('menu').isVisible(), true);
    await page.getByRole('menuitemradio', { name: 'Хэллоуин' }).click();
    assert.equal(await page.getByRole('menu').isVisible(), false);
    assert.equal(await page.evaluate(() => PLTheme.get()), 'night');
    assert.equal(await page.locator('#theme').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('menuitemradio', { name: 'Хэллоуин' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').isVisible(), false);
    await page.evaluate(() => destroyMenu());
    assert.equal(await page.locator('.pl-ui-theme-menu').count(), 0);
    assert.equal(await page.locator('#theme').textContent(), 'old');
    assert.equal(await page.locator('#theme').getAttribute('aria-haspopup'), null);
  } finally { await page.context().close(); }
});
test('keyboard navigation, Tab continuation, and outside dismissal', async () => {
  const page = await setup();
  try {
    await page.evaluate(() => PLTheme.mountMenu(document.querySelector('#theme')));
    await page.locator('#theme').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('menuitemradio', { name: 'Светлая' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.getByRole('menuitemradio', { name: 'Хэллоуин' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('menu').isVisible(), false);
    assert.equal(await page.locator('#after').evaluate(el => el === document.activeElement), true);
    await page.locator('#theme').click();
    await page.locator('#after').click();
    assert.equal(await page.getByRole('menu').isVisible(), false);
  } finally { await page.context().close(); }
});
