import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {chromium,webkit} from '../../it-portal/frontend/node_modules/playwright/index.mjs';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const svg='<svg viewBox="0 0 24 24"><path d="M3 3h18v18H3z"/></svg>';
let missing='',delay=0;
function html(app){
 const web=app==='websites-admin';const prefix=web?'/websites/':'/admin/';
 const extra=web?'<link rel="stylesheet" href="/websites/static/platform.css"><link rel="stylesheet" href="/websites/static/custom-theme.css">':'';
 const sidebar=web?`<aside class="sidebar" id="site-navigation"><nav><a href="#">${svg}<span>Все сайты</span></a></nav></aside>`:`<aside class="sidebar"><nav class="sidebar-nav"><a href="#">${svg}<span>Мониторинг</span></a></nav></aside>`;
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="auth-mode" content="local"><script src="/ecosystem/theme-catalog.js"></script><script src="/ecosystem/theme-runtime.js"></script><link rel="stylesheet" href="${prefix}static/${web?'app.css':'app.css'}">${extra}<link rel="stylesheet" href="/ecosystem/theme-menu.css"><link id="pl-ui-styles" rel="stylesheet" href="/ecosystem/ui-v1.css"><script src="/ecosystem/ui-v1.js" defer></script><script src="${prefix}static/shared-shell.js" defer></script></head><body><div class="app-shell" ${web?'id="app-shell"':''}>${sidebar}<div class="app-body"><header><div class="user-info"><strong class="user-label">Fixture</strong><small>Локальная учётная запись</small></div><div class="header-actions"><form id="logout-form"></form></div><div class="breadcrumb"><strong>Сайты</strong></div></header><main id="main-content"><h1>Fixture content</h1><section class="panel" id="domain-panel">Domain content</section></main></div></div></body></html>`;
}
const server=createServer(async(req,res)=>{
 const p=new URL(req.url,'http://fixture').pathname;
 res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 if(p==='/websites/'||p==='/admin/'){res.setHeader('Content-Type','text/html');res.end(html(p==='/websites/'?'websites-admin':'monitoring-admin'));return;}
 if((missing==='css'&&p==='/ecosystem/ui-v1.css')||(missing==='js'&&p==='/ecosystem/ui-v1.js')){res.writeHead(404).end();return;}
 const path=p.startsWith('/ecosystem/')?resolve(source,'it-portal/frontend/public','.'+p):p.startsWith('/websites/static/')?resolve(source,'websites-admin/app/static',p.slice('/websites/static/'.length)):p.startsWith('/admin/static/')?resolve(source,'monitoring-admin/app/static',p.slice('/admin/static/'.length)):null;
 if(!path){res.writeHead(404).end();return;}
 try{const raw=await readFile(path);if(p==='/ecosystem/ui-v1.css'&&delay)await new Promise(r=>setTimeout(r,delay));res.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');res.end(raw);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const useWebKit=process.env.PL_ADMIN_BROWSER==='webkit';const browser=await(useWebKit?webkit:chromium).launch(useWebKit?{headless:true}:{headless:true,channel:'chrome'});
after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
for(const app of ['/websites/','/admin/']){
 test(`${app} shared startup, expanded and collapsed navigation, desktop themes`,async()=>{
  missing='';delay=100;const page=await browser.newPage();
  try{
   await page.goto(base+app);await page.locator('.pl-ui-shell').waitFor();delay=0;
   for(const width of [998,1280,1920]){
    await page.setViewportSize({width,height:1080});
    for(const theme of ['light','dark','night']){
     await page.evaluate(theme=>window.PLTheme.set(theme),theme);
     assert.equal(await page.locator('.pl-ui-sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width)),226);
     assert.equal(await page.locator('.pl-ui-brand-words').isVisible(),true);
     if(theme==='night') {
      const colors=await page.locator('#domain-panel').evaluate(el=>{
       const theme=window.PLTheme.catalog.find(item=>item.id===window.PLTheme.get());
       const probe=document.createElement('span');probe.style.backgroundColor=theme.palette.surface;
       return {actual:getComputedStyle(el).backgroundColor,expected:probe.style.backgroundColor};
      });
      assert.equal(colors.actual,colors.expected);
     }
     assert.equal(await page.locator('.pl-ui-navigation a > span').first().isVisible(),true);
     assert.equal(await page.locator('.pl-ui-navigation a').first().evaluate(el=>getComputedStyle(el).justifyContent),'normal');
     await page.getByRole('button',{name:'Свернуть меню'}).click();
     assert.equal(await page.locator('.pl-ui-sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width)),80);
     assert.equal(await page.locator('.pl-ui-brand-words').isVisible(),false);
     assert.equal(await page.locator('.pl-ui-navigation a > span').first().isVisible(),false);
     await page.getByRole('button',{name:'Развернуть меню'}).click();
    }
   }
   await page.reload();await page.locator('.pl-ui-shell').waitFor();assert.equal(await page.locator('#main-content h1').textContent(),'Fixture content');
  }finally{delay=0;await page.close();}
 });
 for(const asset of ['js','css'])test(`${app} missing shared ${asset} preserves server rendered fallback`,async()=>{
  missing=asset;const page=await browser.newPage();
  try{await page.goto(base+app);await page.waitForLoadState('load');assert.equal(await page.locator('.pl-ui-shell').count(),0);assert.equal(await page.locator('#main-content h1').textContent(),'Fixture content');}finally{missing='';await page.close();}
 });
}
