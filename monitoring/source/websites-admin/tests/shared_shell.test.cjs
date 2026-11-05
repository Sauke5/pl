const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../app/static/shared-shell.js'), 'utf8');

function localShell(requestSubmit) {
  const listeners = new Map();
  const form = { requestSubmit, hidden: false };
  const identity = { querySelector: selector => selector === 'strong' ? {textContent:'Тест'} : {textContent:'Локальная учётная запись'} };
  const nav = {childNodes: []}, main = {childNodes: []};
  const original = {
    querySelector(selector) {
      return ({'#site-navigation nav':nav, '#main-content':main, '.user-info':identity,
        '.header-actions form':form, '.breadcrumb strong':{textContent:'Сайты'}})[selector] || null;
    },
    replaceWith() {},
  };
  const slot = () => ({append() {}, appendChild() {}, setAttribute() {}, querySelector() { return null; }});
  let config;
  const shared = {
    element: {}, slots: {navigation:slot(),sidebarFooter:slot(),main:slot(),overlays:slot()},
    disabled:false, setLogoutDisabled(value) { this.disabled=value; },
  };
  const window = {
    PLUI:{createShell(options) {config=options;return shared;}},
    addEventListener(name, handler) {listeners.set(name, handler);},
  };
  const document = {getElementById(id) {return id === 'app-shell' ? original : id === 'pl-ui-styles' ? {sheet:{cssRules:[{}]}} : null;}};
  vm.runInNewContext(source, {window,document,Array,Boolean});
  return {shared,config,form,listeners};
}

test('local logout remains disabled through navigation and is restored on BFCache return', async () => {
  let requests=0;
  const shell=localShell(() => {requests++;});
  async function click() {
    if (shell.shared.disabled) return;
    await Promise.resolve(shell.config.onLogout());
  }
  await click(); await click();
  assert.equal(requests,1);
  assert.equal(shell.shared.disabled,true);
  shell.listeners.get('pageshow')({persisted:true});
  assert.equal(shell.shared.disabled,false);
  await click();
  assert.equal(requests,2);
});

test('local logout submission error restores the control', () => {
  const shell=localShell(() => {throw new Error('fixture error');});
  assert.throws(() => shell.config.onLogout(), /fixture error/);
  assert.equal(shell.shared.disabled,false);
});
