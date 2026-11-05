const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ui-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'it-portal/frontend/packages/pl-ui');
  fs.mkdirSync(pkg, { recursive: true });
  for (const name of ['build.mjs', 'core.js', 'styles.css'])
    fs.copyFileSync(path.join(__dirname, name), path.join(pkg, name));
  const output = path.resolve(pkg, '../../public/ecosystem');
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, 'build.mjs'), ...args], { encoding: 'utf8' });
  return { root, pkg, output, run };
}

test('check rejects missing assets without creating output directories', t => {
  const f = fixture(t);
  assert.notEqual(f.run('--check').status, 0);
  assert.equal(fs.existsSync(f.output), false);
});

test('check detects stale bytes and leaves them unchanged', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run('--check').status, 0);
  const asset = path.join(f.output, 'ui-v1.js');
  fs.writeFileSync(asset, 'stale asset');
  assert.notEqual(f.run('--check').status, 0);
  assert.equal(fs.readFileSync(asset, 'utf8'), 'stale asset');
});

test('standalone copies require opt-in and check never creates them', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  for (const name of ['theme-catalog.js', 'theme-runtime.js', 'theme-menu.css'])
    fs.copyFileSync(path.resolve(__dirname, '../../public/ecosystem', name), path.join(f.output, name));
  const standalone = path.join(f.root, 'monitoring-admin/app/static/ecosystem');
  assert.equal(fs.existsSync(standalone), false);
  assert.notEqual(f.run('--check', '--standalone').status, 0);
  assert.equal(fs.existsSync(standalone), false);
  assert.equal(f.run('--standalone').status, 0);
  assert.deepEqual(fs.readFileSync(path.join(standalone, 'ui-v1.js')), fs.readFileSync(path.join(f.pkg, 'core.js')));
  assert.equal(f.run('--check', '--standalone').status, 0);
});
