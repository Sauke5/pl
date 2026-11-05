import { test, expect, type Page, type Locator } from '@playwright/test';
import type { Resource, Preferences } from '../../src/types';

const DOCS_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const NAME = 'Документы PL';
const SITE = 'Москва';
const makeResource = (patch: Partial<Resource>): Resource => ({
  id: DOCS_ID, revision: 7, name: NAME, description: 'Внутренние рабочие документы',
  type: 'Web-сервис', url: 'https://docs.example.test/', ip: '192.0.2.17', hostname: 'docs.example.test',
  aliases: ['docs-alias'], directions: ['Документы'], site: SITE, environment: 'Production',
  tags: ['внутренний'], endpoints: [], links: [{ name: 'Инструкция', url: 'https://docs.example.test/help' }],
  relations: [{ resource_id: HOST_ID, label: 'Размещено на' }], source: 'manual', external_ids: ['netbox:42'],
  check: { kind: '', target: '', interval_seconds: 0 }, operations: [], executor_target: '', lifecycle: 'active',
  created_at: '2026-10-01T09:00:00Z', updated_at: '2026-11-03T10:00:00Z', ...patch,
});

type Mutation = { method: string; path: string; headers: Record<string, string>; body: unknown };
async function fixture(page: Page, managed = false, doska = false) {
  const resources = [
    makeResource({ managed_module_id: managed ? HOST_ID : undefined }),
    makeResource({ id: HOST_ID, name: 'DOCS-HOST-01', type: 'Сервер', url: '', ip: '192.0.2.18', relations: [], aliases: [] }),
    makeResource({ id: '33333333-3333-4333-8333-333333333333', name: 'Мониторинг', url: 'https://monitor.example.test/', directions: ['Мониторинг'], site: 'Цитадель', environment: 'Test', relations: [] }),
    makeResource({ id: '44444444-4444-4444-8444-444444444444', name: 'Недоверенная ссылка', url: 'javascript:alert(1)', relations: [], site: 'Цитадель' }),
  ];
  let preferences: Preferences = { revision: 3, favorites: [DOCS_ID], hidden_sections: [], section_order: [], sidebar_collapsed: false };
  const mutations: Mutation[] = [];
  const taskReads: unknown[] = [];
  const resourceQueries: string[] = [];
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, '__clipboardWrites', { value: writes });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { writes.push(value); },
      readText: async () => writes.at(-1) || '',
    } });
  });
  await page.context().route('https://docs.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture documents</title>' }));
  await page.route('**/doska/api/doska/catalog/task-links', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
    taskReads.push(route.request().postDataJSON());
    await route.fulfill({ json: { version: 1, items: [{ projectId: 'docs', taskId: 'review', title: 'Проверить документацию', href: '/doska/projects/docs?taskId=review' }], nextCursor: null } });
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    if (!['GET', 'HEAD'].includes(method)) {
      mutations.push({ method, path, headers: request.headers(), body: request.postData() ? request.postDataJSON() : undefined });
      if (path === '/preferences' && method === 'PUT') {
        preferences = { ...request.postDataJSON(), revision: preferences.revision + 1 };
        return route.fulfill({ json: preferences });
      }
      if (path === `/resources/${DOCS_ID}` && method === 'DELETE') {
        resources[0] = { ...resources[0], lifecycle: 'archived', revision: resources[0].revision + 1 };
        return route.fulfill({ json: resources[0] });
      }
      if (path === `/resources/${DOCS_ID}` && method === 'PUT') {
        resources[0] = { ...resources[0], ...request.postDataJSON(), revision: resources[0].revision + 1 };
        return route.fulfill({ json: resources[0] });
      }
      throw new Error(`Unexpected fixture mutation ${method} ${path}`);
    }
    if (path === '/resources' || path === '/search') {
      resourceQueries.push(url.search);
      const p = url.searchParams;
      let selected = resources.filter(r =>
        (!p.get('direction') || r.directions.includes(p.get('direction')!)) &&
        (!p.get('site') || r.site === p.get('site')) &&
        (!p.get('environment') || r.environment === p.get('environment')) &&
        (!p.get('lifecycle') || r.lifecycle === p.get('lifecycle')) &&
        (!p.get('q') || `${r.name} ${r.description} ${r.ip}`.toLowerCase().includes(p.get('q')!.toLowerCase())),
      );
      if (p.get('sort') === 'name') selected = [...selected].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return route.fulfill({ json: selected });
    }
    const resource = resources.find(r => path === `/resources/${r.id}`);
    if (resource) return route.fulfill({ json: resource });
    if (/^\/resources\/[^/]+\/inventory$/.test(path)) return route.fulfill({ json: { sources: [] } });
    if (/^\/resources\/[^/]+\/configuration-history$/.test(path)) return route.fulfill({ json: [] });
    const data: Record<string, unknown> = {
      '/session': { authenticated: true, user: { id: 'catalog-fixture-admin', name: 'Администратор', admin: true }, csrf_token: 'fixture-csrf', timezone: 'Europe/Moscow', features: { doska } },
      '/preferences': preferences, '/workspace-preferences': { revision: 0, system_ids: [], groups: [] },
      '/dashboard-layout': { revision: 0, tiles: [], hidden: [] }, '/help-state': { disabled: true, seen: [] },
      '/chart-settings': { revision: 1, charts: [] }, '/wayline': { sources: [] },
      '/dictionaries': { revision: 1, types: ['Web-сервис', 'Сервер'], directions: ['Документы', 'Мониторинг'], sites: [SITE, 'Цитадель'], environments: ['Production', 'Test'], relation_types: ['Размещено на'] },
    };
    await route.fulfill({ json: data[path] ?? [] });
  });
  return { resources, mutations, taskReads, resourceQueries };
}
const rowFor = (page: Page) => page.locator('.resource-row').filter({ has: page.getByRole('button', { name: NAME, exact: true }) });
const drawerFor = (page: Page) => page.getByRole('dialog', { name: NAME, exact: true });
async function openName(page: Page) {
  await page.getByRole('button', { name: NAME, exact: true }).click();
  await expect(drawerFor(page)).toBeVisible();
  return drawerFor(page);
}
async function expectContained(page: Page, drawer?: Locator) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (drawer) await expect.poll(() => drawer.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.left >= 16 && rect.top >= 16 && rect.right <= innerWidth - 16 && rect.bottom <= innerHeight - 16 && rect.height < innerHeight && parseFloat(getComputedStyle(el).borderTopRightRadius) > 0;
  })).toBe(true);
}

test('dense columns and row, name and more open the same resource drawer', async ({ page }) => {
  await fixture(page);
  await page.goto('/#catalog');
  const header = page.locator('.catalog-table-header');
  for (const column of ['Ресурс', 'IP', 'Направление', 'Площадка', 'Среда']) await expect(header.getByText(column, { exact: true })).toBeVisible();
  const search = await page.locator('.catalog-filter-search input').boundingBox();
  const sort = await page.locator('.catalog-filter-sort').boundingBox();
  const secondRow = await page.locator('.filter-bar > select:not(.catalog-filter-sort), .filter-bar > .tag-filter').evaluateAll(elements => elements.map(el => { const box = el.getBoundingClientRect(); return { y: box.y, width: box.width, height: box.height }; }));
  expect(search).not.toBeNull(); expect(sort).not.toBeNull();
  expect(Math.abs(search!.y - sort!.y)).toBeLessThan(2);
  for (const box of secondRow) {
    expect(Math.abs(box.height - search!.height)).toBeLessThan(2);
    expect(Math.abs(box.y - secondRow[0].y)).toBeLessThan(2);
    expect(Math.abs(box.width - sort!.width)).toBeLessThan(2);
    expect(box.y).toBeGreaterThan(search!.y + search!.height);
  }
  const row = rowFor(page);
  await expect(row).toContainText('192.0.2.17');
  await expect(row).toContainText(SITE);
  await expect(row).toContainText('Production');
  let drawer = await openName(page);
  const cardClass = await drawer.getAttribute('class');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: `Подробнее: ${NAME}`, exact: true }).click();
  await expect(drawerFor(page)).toHaveAttribute('class', cardClass!);
  await page.keyboard.press('Escape');
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await row.click({ position: { x: box!.width - 2, y: box!.height - 2 } });
  drawer = drawerFor(page);
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('class', cardClass!);
});

test('external arrow is a safe new-tab link and copying IP does not open the card', async ({ page }) => {
  await fixture(page);
  await page.goto('/#catalog');
  const row = rowFor(page);
  const external = row.getByRole('link', { name: `Открыть ${NAME}`, exact: true });
  await expect(external).toHaveAttribute('href', 'https://docs.example.test/');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  const popupReady = page.waitForEvent('popup');
  await external.click();
  const popup = await popupReady;
  await expect(popup).toHaveURL('https://docs.example.test/');
  await popup.close();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row.getByRole('button', { name: /Скопировать IP/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites)).toEqual(['192.0.2.17']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test('favorites navigation preserves search, site, environment and URL across reload', async ({ page }) => {
  await fixture(page);
  await page.goto('/#catalog?kind=applications');
  await page.locator('.catalog-filter-search input').fill('Документы');
  await page.getByRole('combobox', { name: 'Площадка', exact: true }).selectOption(SITE);
  await page.getByRole('combobox', { name: 'Среда', exact: true }).selectOption('Production');
  await page.locator('.catalog-nav').getByRole('button', { name: /^Избранное/ }).click();
  await expect(rowFor(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Мониторинг', exact: true })).toHaveCount(0);
  const assertFilters = () => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
  await expect.poll(assertFilters).toMatchObject({ favorites: 'true', q: 'Документы', site: SITE, environment: 'Production', kind: 'applications' });
  await page.reload();
  await expect(rowFor(page)).toBeVisible();
  await expect(page.locator('.catalog-filter-search input')).toHaveValue('Документы');
  await expect(page.getByRole('combobox', { name: 'Площадка', exact: true })).toHaveValue(SITE);
  await expect.poll(assertFilters).toMatchObject({ favorites: 'true', q: 'Документы', site: SITE, environment: 'Production' });
});

test('catalog and home share resource lifecycle, metadata, relations and Doska task card', async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto('/#catalog');
  const drawer = await openName(page);
  const cardClass = await drawer.getAttribute('class');
  await expect(drawer.getByRole('link', { name: `Открыть ${NAME}`, exact: true })).toHaveAttribute('href', 'https://docs.example.test/');
  await expect(drawer.getByText('Активен в каталоге', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Не настроена', { exact: true })).toBeVisible();
  await expect(drawer.getByText('DOCS-HOST-01', { exact: true })).toBeVisible();
  const tasks = drawer.getByRole('region', { name: 'Задачи Doska' });
  await expect(tasks.getByRole('link', { name: 'Проверить документацию' })).toHaveAttribute('href', '/doska/projects/docs?taskId=review');
  expect(state.taskReads[0]).toEqual({ selection: { resourceId: DOCS_ID, sourceKind: 'platform' }, limit: 20, cursor: null });
  await drawer.getByText('Дополнительные данные', { exact: true }).click();
  await expect(drawer.getByText('docs-alias', { exact: true })).toBeVisible();
  await expect(drawer.locator('pre')).toContainText('netbox:42');
  await page.keyboard.press('Escape');
  await page.goto('/');
  const homeDetails = page.getByRole('button', { name: `Подробнее: ${NAME}`, exact: true });
  await homeDetails.click();
  await expect(drawerFor(page)).toBeVisible();
  await expect(drawerFor(page)).toHaveAttribute('class', cardClass!);
  await expect(drawerFor(page).getByText('Активен в каталоге', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(homeDetails).toBeFocused();
});

test('drawer traps focus and Escape or close returns focus to its trigger', async ({ page }) => {
  await fixture(page);
  await page.goto('/#catalog');
  const trigger = page.getByRole('button', { name: NAME, exact: true });
  const drawer = await openName(page);
  const focusable = drawer.locator('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]').filter({ visible: true });
  const count = await focusable.count();
  expect(count).toBeGreaterThan(3);
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawerFor(page).getByRole('button', { name: /^Закрыть/, exact: false }).first().click();
  await expect(drawerFor(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('footer edit and archive retain cancellation and revision precondition', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/#catalog');
  let drawer = await openName(page);
  await drawer.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  drawer = await openName(page);
  await drawer.getByRole('button', { name: 'В архив', exact: true }).click();
  await expect(drawer.getByText(/Запись сохранится в архиве/)).toBeVisible();
  expect(state.mutations.filter(m => m.method === 'DELETE')).toHaveLength(0);
  await drawer.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(state.mutations.filter(m => m.method === 'DELETE')).toHaveLength(0);
  await drawer.getByRole('button', { name: 'В архив', exact: true }).click();
  await drawer.getByRole('button', { name: 'Архивировать', exact: true }).click();
  await expect.poll(() => state.mutations.filter(m => m.method === 'DELETE').length).toBe(1);
  const deletion = state.mutations.find(m => m.method === 'DELETE')!;
  expect(deletion.path).toBe(`/resources/${DOCS_ID}`);
  expect(deletion.headers['if-match']).toBe('7');
  expect(deletion.headers['x-csrf-token']).toBe('fixture-csrf');
  await expect(drawerFor(page)).toHaveCount(0);
});

for (const [width, height] of [[1920, 1080], [1920, 1200], [3440, 1440], [3840, 2160]]) {
  for (const theme of ['dark', 'light', 'night']) {
    test(`dense catalog and drawer fit ${width}x${height} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('pl-ui-theme', value), theme);
      await fixture(page);
      await page.goto('/#catalog');
      await expect(rowFor(page)).toBeVisible();
      await expectContained(page);
      const drawer = await openName(page);
      await expectContained(page, drawer);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if ((width === 1920 && height === 1080 && theme === 'dark') || (width === 3440 && theme === 'night')) {
        await page.screenshot({ path: test.info().outputPath(`catalog-drawer-${width}-${theme}.png`) });
      }
    });
  }
}

test('managed module resource retains lifecycle ownership in the floating card', async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto('/#catalog');
  const drawer = await openName(page);
  await expect(drawer.getByText('Карточка создана модулем.', { exact: false })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'В архив', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Редактировать', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('link', { name: 'Управление модулем', exact: true })).toHaveAttribute('href', `#modules?instance=${HOST_ID}`);
  expect(state.mutations).toHaveLength(0);
});
