// Run: PL_TEST_BROWSER_CHANNEL=chrome node --test packages/pl-ui/core.test.cjs
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {chromium} = require('@playwright/test');
const core = readFileSync(path.join(__dirname,'core.js'),'utf8');
const css = readFileSync(path.join(__dirname,'styles.css'),'utf8');
const assets = path.join(__dirname,'../../public/ecosystem');
const catalog = readFileSync(path.join(assets,'theme-catalog.js'),'utf8');
const theme = readFileSync(path.join(assets,'theme-runtime.js'),'utf8');
const themeCss = readFileSync(path.join(assets,'theme-menu.css'),'utf8');
let browser;
before(async () => { browser = await chromium.launch({headless:true,...(process.env.PL_TEST_BROWSER_CHANNEL ? {channel:process.env.PL_TEST_BROWSER_CHANNEL} : {})}); });
after(async () => { if (browser) await browser.close(); });
async function setup(width=1920,height=1080,withTheme=true) {
  const context = await browser.newContext({viewport:{width,height}}), page = await context.newPage();
  await page.route('http://ui.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="theme-color"><style>html,body{margin:0}</style>'}));
  await page.goto('http://ui.test/');
  if (withTheme) { await page.addScriptTag({content:catalog}); await page.addScriptTag({content:theme}); await page.addStyleTag({content:themeCss}); }
  await page.addScriptTag({content:core}); await page.addStyleTag({content:css}); return page;
}
test('shell controls, content safety and theme lifecycle',async()=>{
  const p=await setup(); try {
    await p.evaluate(()=>{window.calls={logout:0,navigate:0,collapse:[]};window.shell=PLUI.createShell({context:'Обзор',user:{name:'Иван',subtitle:'Пользователь Платформы'},navigationId:'nav-test',onLogout:()=>calls.logout++,onPlatformNavigate:e=>{e.preventDefault();calls.navigate++;},onCollapsedChange:v=>calls.collapse.push(v)});shell.slots.navigation.innerHTML='<a class="nav-item active" href="#overview"><svg></svg><span class="nav-label">Обзор</span></a>';shell.slots.main.textContent='Содержимое';document.body.append(shell.element);});
    assert.equal(await p.locator('main#main-content').textContent(),'Содержимое');
    await p.getByRole('link',{name:'Платформа',exact:true}).click(); await p.getByRole('button',{name:'Выйти'}).click();
    assert.deepEqual(await p.evaluate(()=>[calls.navigate,calls.logout]),[1,1]);
    const toggle=p.getByRole('button',{name:'Свернуть меню'}); assert.equal(await toggle.getAttribute('aria-controls'),'nav-test'); await toggle.click();
    assert.equal(await p.locator('.nav-label').isVisible(),false);
    assert.deepEqual(await p.evaluate(()=>[PLUI.sidebar.get(),calls.collapse,localStorage.getItem('pl-ui-sidebar-collapsed')]),[true,[true],'true']);
    await p.getByRole('button',{name:'Выбрать тему'}).click(); await p.getByRole('menuitemradio',{name:'Хэллоуин'}).click(); assert.equal(await p.evaluate(()=>PLTheme.get()),'night');
    await p.evaluate(()=>{shell.setContext('<img src=x>');shell.setUser({name:'<b>Имя</b>'});});
    assert.equal(await p.locator('.pl-ui-context img').count(),0); assert.equal(await p.locator('.pl-ui-user-info strong').textContent(),'<b>Имя</b>');
    await p.evaluate(()=>shell.setContext(''));
    assert.equal(await p.locator('.pl-ui-breadcrumb-separator').isVisible(),false);
    await p.evaluate(()=>{shell.destroy();shell.destroy();}); assert.equal(await p.locator('.pl-ui-theme-menu').count(),0);
  } finally {await p.context().close();}
});
test('sidebar cross-tab, cleanup and unavailable storage',async()=>{
  const p=await setup(), q=await p.context().newPage(); try {
    await q.route('http://ui.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await q.goto('http://ui.test/other');await q.addScriptTag({content:core});
    await p.evaluate(()=>{window.a=PLUI.createShell({});window.b=PLUI.createShell({});document.body.append(a.element,b.element);});
    await q.evaluate(()=>{window.s=PLUI.createShell({});document.body.append(s.element);});
    await p.evaluate(()=>PLUI.sidebar.set(true));await q.waitForFunction(()=>s.element.classList.contains('sidebar-collapsed'));
    assert.deepEqual(await p.evaluate(()=>[a.element.classList.contains('sidebar-collapsed'),b.element.classList.contains('sidebar-collapsed')]),[true,true]);
    await p.evaluate(()=>{a.destroy();PLUI.sidebar.set(false);});await q.waitForFunction(()=>!s.element.classList.contains('sidebar-collapsed'));
    assert.deepEqual(await p.evaluate(()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('blocked')}});let seen=[];const off=PLUI.sidebar.subscribe(v=>seen.push(v));PLUI.sidebar.set(true);off();PLUI.sidebar.set(false);return [seen,PLUI.sidebar.get()];}),[[true],false]);
  } finally {await q.close();await p.context().close();}
});
test('desktop geometry, wide mode, fallback and CSS controls',async()=>{
  for(const [width,height,expected] of [[1920,1080,[226,1694,226,38]],[3440,1440,[240,2730,475,56]]]) {
    const p=await setup(width,height,false); try {
      assert.deepEqual(await p.evaluate(()=>{window.s=PLUI.createShell({context:'Сервис'});document.body.append(s.element);const a=s.element.querySelector('.pl-ui-sidebar').getBoundingClientRect(),m=s.slots.main.getBoundingClientRect();return [a.width,m.width,m.x,parseFloat(getComputedStyle(s.slots.main).paddingLeft)];}),expected);
      assert.equal(await p.getByRole('button',{name:'Выбрать тему'}).isDisabled(),true);
      assert.equal(await p.getByRole('button',{name:'Выйти'}).count(),0);
      assert.equal(await p.evaluate(()=>{s.element.classList.add('pl-ui-shell-wide');return s.slots.main.getBoundingClientRect().width;}),width-expected[0]);
      assert.deepEqual(await p.evaluate(()=>{const b=document.createElement('button'),i=document.createElement('input');b.className=PLUI.buttonClasses({variant:'default'});i.className='pl-ui-input';s.slots.main.append(b,i);return [getComputedStyle(b).minHeight,getComputedStyle(b).fontSize,getComputedStyle(i).minHeight];}),['39px','13px','42px']);
      assert.equal(await p.evaluate(()=>{s.destroy();const x=PLUI.createShell({sidebar:false});document.body.append(x.element);return x.element.querySelectorAll('.pl-ui-sidebar').length;}),0);
    } finally {await p.context().close();}
  }
});
test('pending logout disables repeats and is restored after completion',async()=>{
  const p=await setup();try {
    await p.evaluate(()=>{window.count=0;window.s=PLUI.createShell({onLogout:()=>{count++;return new Promise(resolve=>window.finish=resolve);}});document.body.append(s.element);});
    const button=p.getByRole('button',{name:'Выйти'});await button.click();assert.equal(await button.isDisabled(),true);await p.evaluate(()=>finish());await p.waitForFunction(()=>!document.querySelector('.pl-ui-logout').disabled);assert.equal(await p.evaluate(()=>count),1);
  }finally{await p.context().close();}
});
test('rejected logout reports failure and externally disabled state survives pending action',async()=>{
 const p=await setup();try {
  await p.evaluate(()=>{window.s=PLUI.createShell({onLogout:()=>Promise.reject(new Error('private upstream detail'))});document.body.append(s.element);});
  await p.getByRole('button',{name:'Выйти'}).click();
  await p.getByRole('alert').waitFor();
  assert.equal(await p.getByRole('alert').textContent(),'Не удалось выйти. Повторите действие.');
  await p.evaluate(()=>s.setLogoutDisabled(true));
  assert.equal(await p.getByRole('button',{name:'Выйти'}).isDisabled(),true);
 }finally{await p.context().close();}
});
test('shell fills a flex host and owns navigation and footer icon dimensions', async()=>{
 const p=await setup();try {
  const geometry=await p.evaluate(()=>{
   document.body.style.display='flex';window.s=PLUI.createShell({});
   const link='<a href="#test"><svg viewBox="0 0 24 24"></svg><span>Сервис</span></a>';
   s.slots.navigation.innerHTML=link;s.slots.sidebarFooter.innerHTML=link+'<div class="pl-ui-sidebar-caption"><strong>PL</strong><span>Статус</span></div>';document.body.append(s.element);
   return {width:s.element.getBoundingClientRect().width,icons:[...s.element.querySelectorAll('.pl-ui-navigation svg,.pl-ui-sidebar-footer svg')].map(x=>[x.getBoundingClientRect().width,x.getBoundingClientRect().height]),caption:getComputedStyle(s.element.querySelector('.pl-ui-sidebar-caption')).display};
  });
  assert.deepEqual(geometry,{width:1920,icons:[[21,21],[21,21]],caption:'flex'});
 }finally{await p.context().close();}
});
test('neutral default brand and configurable text use the shared core', async () => {
  const page = await setup();
  try {
    await page.evaluate(() => {
      document.body.append(PLUI.createBrand());
      document.body.append(PLUI.createBrand({ branding: { name: 'Customer <b>', subtitle: 'Console', label: 'Customer platform' } }));
    });
    assert.equal(await page.locator('.pl-ui-brand').first().getAttribute('aria-label'), 'Platform');
    assert.equal(await page.locator('.pl-ui-brand strong').first().textContent(), 'PL');
    assert.equal(await page.getByRole('link', { name: 'Customer platform', exact: true }).locator('strong').textContent(), 'Customer <b>');
    assert.equal(await page.locator('.pl-ui-brand b').count(), 0);
  } finally { await page.context().close(); }
});
