const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(app, values = {}, blocked = false, controller) {
  const source = fs.readFileSync(path.join(__dirname, '../../', app, 'app/static/theme.js'), 'utf8');
  const data = new Map(Object.entries(values));
  const events = new Map();
  const root = { dataset: {}, style: {}, classList: { toggle(_name, enabled) { root.light = enabled; } } };
  const window = {
    PLTheme: controller,
    addEventListener(name, callback) { events.set(name, callback); },
    dispatchEvent(event) { events.get(event.type)?.(event); }
  };
  vm.runInNewContext(source, {
    document: { documentElement: root, addEventListener() {}, querySelector() { return null; }, getElementById() { return null; } },
    window, Event,
    localStorage: {
      getItem(key) { if (blocked) throw Error('blocked'); return data.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw Error('blocked'); data.set(key, value); }
    }
  });
  return { data, root, window, events };
}

for (const app of ['monitoring-admin', 'websites-admin']) {
  test(`${app}: central controller is preserved and its color scheme drives legacy page styles`, () => {
    let notify, scheme = 'dark';
    const controller = { version: 1, getColorScheme() { return scheme; }, subscribe(fn) { notify = fn; } };
    const result = boot(app, {}, false, controller);
    assert.equal(result.window.PLTheme, controller);
    assert.equal(result.root.light, false);
    scheme = 'light'; notify(); assert.equal(result.root.light, true);
  });
  test(`${app}: missing runtime renders safely without replacing an unknown saved ID`, () => {
    const { root, data } = boot(app, { 'pl-ui-theme': 'future-theme' });
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(root.style.colorScheme, 'dark');
    assert.equal(data.get('pl-ui-theme'), 'future-theme');
  });
  test(`${app}: fallback switch persists the common preference and notifies controls`, () => {
    const { root, data, window, events } = boot(app);
    let changed = 0;
    events.set('pl-ui-theme-change', () => changed++);
    window.PLTheme.set('light');
    assert.equal(root.light, true);
    assert.equal(data.get('pl-ui-theme'), 'light');
    assert.equal(changed, 1);
  });
  test(`${app}: storage event updates another tab without writeback`, () => {
    const { root, events, data } = boot(app);
    events.get('storage')({ key: 'pl-ui-theme', newValue: 'light' });
    assert.equal(root.dataset.theme, 'light');
    assert.equal(data.has('pl-ui-theme'), false);
    events.get('storage')({ key: 'unrelated', newValue: 'dark' });
    assert.equal(root.dataset.theme, 'light');
    events.get('storage')({ key: null, newValue: null });
    assert.equal(root.dataset.theme, 'dark');
  });
  test(`${app}: blocked storage does not prevent local switching`, () => {
    const { root, window } = boot(app, {}, true);
    window.PLTheme.set('light');
    assert.equal(root.dataset.theme, 'light');
  });
}
