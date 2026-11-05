const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../app/static/shared-shell.js'), 'utf8');

function makeShell(requestSubmit, mode = 'local', sessionReady = false) {
  const listeners = new Map();
  const form = {requestSubmit, hidden:false};
  const nav = {childNodes:[]}, main = {childNodes:[]};
  const original = {
    querySelector(selector) {
      return ({'.sidebar-nav':nav, '#main-content':main, '#logout-form':form,
        '.user-label':{textContent:'Тест'}, '.user-info small':{textContent:'Локальная учётная запись'}})[selector] || null;
    },
    replaceWith() {},
  };
  const slot = () => ({classList:{add() {}},append() {},appendChild() {},setAttribute() {}});
  let config;
  const shared = {element:{},slots:{navigation:slot(),sidebarFooter:slot(),main:slot(),footer:slot(),overlays:slot()},
    disabled:false,setLogoutDisabled(value) {this.disabled=value;}};
  const window = {PLUI:{createShell(options) {config=options;return shared;}},
    addEventListener(name, handler) {listeners.set(name,handler);}};
  if (sessionReady) window.plMonitoringPlatformLogout = () => 'gateway';
  const document = {
    querySelector(selector) {return selector === 'meta[name="auth-mode"]' ? {content:mode} : original;},
    getElementById() {return {sheet:{cssRules:[{}]}};},
  };
  vm.runInNewContext(source, {window,document,Array,Boolean});
  window.plMonitoringPlatformLogout = () => 'gateway';
  return {shared,config,listeners};
}

test('local logout stays disabled through navigation and is restored on BFCache return', async () => {
  let requests=0;
  const shell=makeShell(() => {requests++;});
  async function click() {if (!shell.shared.disabled) await Promise.resolve(shell.config.onLogout());}
  await click(); await click();
  assert.equal(requests,1);
  assert.equal(shell.shared.disabled,true);
  shell.listeners.get('pageshow')({persisted:true});
  assert.equal(shell.shared.disabled,false);
  await click();
  assert.equal(requests,2);
});

test('local logout submit failure restores the control', () => {
  const shell=makeShell(() => {throw new Error('fixture error');});
  assert.throws(() => shell.config.onLogout(), /fixture error/);
  assert.equal(shell.shared.disabled,false);
});

test('gateway logout stays disabled on BFCache until its session is checked', () => {
  const shell=makeShell(() => {}, 'gateway');
  assert.equal(shell.shared.disabled,true);
  shell.listeners.get('pageshow')({persisted:true});
  assert.equal(shell.shared.disabled,true);
  assert.equal(shell.config.onLogout(),'gateway');
});

test('late stylesheet enhancement preserves an already verified gateway session', () => {
  const shell=makeShell(() => {}, 'gateway', true);
  assert.equal(shell.shared.disabled,false);
  assert.equal(shell.config.onLogout(),'gateway');
});
