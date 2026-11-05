const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

test('header keeps the canonical theme action labels after initialization', () => {
  const app = read('../app/static/app.js');
  assert.match(app, /light \? "Переключить на тёмную тему" : "Переключить на светлую тему"/);
});

test('header styles the caption nested beside the user name', () => {
  const css = read('../app/static/app.css');
  assert.match(css, /\.user-info > span > small\s*\{[^}]*font-size:11px;[^}]*font-weight:400;[^}]*color:var\(--muted-text-color\)/);
});
