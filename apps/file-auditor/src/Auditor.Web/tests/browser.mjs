// Browser acceptance uses only the local, read-only fixture server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';

async function fixture(admin) {
  const child = spawn(process.execPath, ['tests/ui-fixture-server.mjs'], {
    env: { ...process.env, FIXTURE_ADMIN: admin ? '1' : '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [chunk] = await once(child.stdout, 'data');
  const port = /fixture listening (\d+)/.exec(chunk.toString())?.[1];
  if (!port) { child.kill(); throw new Error('fixture did not start'); }
  return { child, origin: `http://127.0.0.1:${port}` };
}

for (const [name, engine, options] of [['chromium', chromium, { channel: 'chrome' }], ['webkit', webkit, {}]]) {
  const browser = await engine.launch({ headless: true, ...options });
  try {
    for (const admin of [true, false]) {
      const server = await fixture(admin);
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        const failures = [];
        page.on('response', response => {
          if (response.status() >= 400 && new URL(response.url()).pathname !== '/audit-arch/api/instance') failures.push(response.url());
        });
        await page.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
        await page.goto(`${server.origin}/audit/`);
        await page.getByRole('heading', { name: 'Срез ещё не создан' }).waitFor();
        assert.equal(await page.title(), 'Файловый аудитор · PL');
        assert.equal(await page.getByText('test-server', { exact: true }).count() > 0, true);
        assert.equal(await page.getByRole('link', { name: 'Платформа', exact: true }).getAttribute('href'), '/');
        for (const width of [1920, 2560, 3440]) {
          await page.setViewportSize({ width, height: 1080 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow ${width}`);
        }
        for (const [label, id] of [['Светлая', 'light'], ['Тёмная', 'dark'], ['Хэллоуин', 'night']]) {
          await page.getByRole('button', { name: 'Выбрать тему' }).click();
          await page.getByRole('menuitemradio', { name: label }).click();
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), id);
        }
        await page.reload();
        await page.getByRole('heading', { name: 'Срез ещё не создан' }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'night');
        await page.getByRole('link', { name: 'Сканирования', exact: true }).click();
        await page.getByRole('checkbox', { name: /Документы/ }).waitFor();
        const scan = page.getByRole('button', { name: 'Новый срез' });
        await page.waitForTimeout(100);
        assert.equal(await scan.isEnabled(), admin, `${name} scan permission`);
        if (admin) {
          await scan.click();
          await page.getByRole('dialog', { name: 'Запустить сканирование?' }).waitFor();
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('dialog').count(), 0);
        }
        assert.deepEqual(failures, [], `${name} unexpected HTTP failure`);
      } finally {
        await context.close();
        server.child.kill();
        await once(server.child, 'exit');
      }
    }
    process.stdout.write(`${name}: admin/viewer, themes, navigation and responsive widths passed\n`);
  } finally { await browser.close(); }
}
