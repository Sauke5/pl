const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');

function harness(responses) {
  let click;
  const calls = [];
  const navigations = [];
  const progressStates = [];
  const button = { disabled: false, addEventListener(type, handler) { if (type === 'click') click = handler; } };
  const error = { hidden: true, textContent: '', scrollIntoView() {} };
  const progress = { classList: { toggle(_class, value) { progressStates.push(value); } }, setAttribute() {} };
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) { return { 'session-error': error, 'page-progress': progress, 'page-progress-label': {} }[id] || null; },
    querySelector(selector) { return selector === '[data-platform-logout]' ? button : null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: { addEventListener() {} },
  };
  const window = {
    matchMedia() { return { addEventListener() {} }; },
    addEventListener() {},
    location: { assign(url) { navigations.push(url); } },
  };
  vm.runInNewContext(source, {
    document, window, localStorage: { getItem() { return null; } },
    async fetch(url, options) {
      calls.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      assert.ok(next, 'Unexpected extra fetch');
      return next;
    },
  });
  return { click, button, error, calls, navigations, progressStates };
}

function response(status, data = {}) {
  return { status, ok: status >= 200 && status < 300, async json() { return data; } };
}

test('logout fetches portal CSRF and uses it only in portal POST before navigating', async () => {
  const h = harness([response(200, { authenticated: true, csrf_token: 'portal-csrf-test' }), response(204)]);
  const pending = h.click();
  assert.equal(h.button.disabled, true);
  assert.equal(h.progressStates[0], true);
  await pending;
  assert.deepEqual(h.calls.map(call => call.url), ['/api/v1/session', '/auth/logout']);
  const [session, logout] = h.calls;
  assert.equal(session.options.credentials, 'same-origin');
  assert.equal(session.options.cache, 'no-store');
  assert.equal(session.options.redirect, 'error');
  assert.equal(session.options.headers, undefined);
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.credentials, 'same-origin');
  assert.equal(logout.options.redirect, 'error');
  assert.equal(logout.options.headers['X-CSRF-Token'], 'portal-csrf-test');
  assert.equal(logout.options.headers['Content-Type'], 'application/json');
  assert.equal(logout.options.body, '{}');
  assert.deepEqual(h.navigations, ['/']);
  assert.equal(h.error.hidden, true);
  assert.equal(h.button.disabled, false);
  assert.equal(h.progressStates.at(-1), false);
});

for (const [name, responses, count] of [
  ['session 401', [response(401)], 1],
  ['session unauthenticated', [response(200, { authenticated: false })], 1],
  ['logout 401', [response(200, { csrf_token: 'test' }), response(401)], 2],
]) {
  test(`${name} redirects an expired session to portal`, async () => {
    const h = harness(responses);
    await h.click();
    assert.deepEqual(h.navigations, ['/']);
    assert.equal(h.calls.length, count);
    assert.equal(h.error.hidden, true);
    assert.equal(h.button.disabled, false);
    assert.equal(h.progressStates.at(-1), false);
  });
}

for (const [name, responses, count] of [
  ['session 503', [response(503)], 1],
  ['session network error', [new Error('offline')], 1],
  ['missing CSRF', [response(200, { authenticated: true })], 1],
  ['empty CSRF', [response(200, { csrf_token: '' })], 1],
  ['non-string CSRF', [response(200, { csrf_token: 42 })], 1],
  ['invalid session JSON', [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid json'); } })], 1],
  ['logout 403', [response(200, { csrf_token: 'test' }), response(403)], 2],
  ['logout 500', [response(200, { csrf_token: 'test' }), response(500)], 2],
  ['logout network error', [response(200, { csrf_token: 'test' }), new Error('offline')], 2],
]) {
  test(`${name} preserves page and restores actionable controls with an error`, async () => {
    const h = harness(responses);
    await h.click();
    assert.deepEqual(h.navigations, []);
    assert.equal(h.calls.length, count);
    assert.equal(h.error.hidden, false);
    assert.match(h.error.textContent, /Не удалось завершить сеанс Платформы/);
    assert.equal(h.button.disabled, false);
    assert.equal(h.progressStates.at(-1), false);
  });
}

test('retry clears previous error and completes without persisting CSRF', async () => {
  const h = harness([response(503), response(200, { csrf_token: 'fresh' }), response(204)]);
  await h.click();
  assert.equal(h.error.hidden, false);
  const retry = h.click();
  assert.equal(h.error.hidden, true);
  await retry;
  assert.deepEqual(h.navigations, ['/']);
  assert.equal(h.calls[2].options.headers['X-CSRF-Token'], 'fresh');
});
