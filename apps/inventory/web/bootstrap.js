'use strict';
(async () => {
  await (window.plInventoryShellReady || Promise.resolve());
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ARRAY_KEYS = ['sources','questions','coverage','software','office','windows','licensing','priority','catalogPriority','sections','attempts','servers','virtualization','developerReferences'];
  const CORE_KEYS = ['sources','questions','coverage','software','office','windows','licensing','priority'];
  const MAX_UPLOAD = 64 * 1024 * 1024;
  const STORED_JOB = 'pl-ui-inventory-import-job';
  const reportTemplate = $('report-workspace').innerHTML;
  const navTemplate = document.querySelector('.tabs').innerHTML;
  const detailsTemplate = $('details-dialog').cloneNode(true);
  let session = null;
  let currentData = null;
  let reportInstance = null;
  let refreshPending = false;
  let booting = false;
  let importState = { phase:'idle', uploadKey:null, commitKey:null, jobId:null, preview:null };
  let pollGeneration = 0;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  if (window.PLTheme?.mountMenu) {
    for (const id of ['theme-toggle','bootstrap-theme']) window.PLTheme.mountMenu($(id));
  } else {
    // Standalone previews retain the legacy switch when Platform assets are absent.
  function setTheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    const label = dark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему';
    const icon = dark ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20.5 14.3A8.8 8.8 0 0 1 9.7 3.5a8.8 8.8 0 1 0 10.8 10.8Z"/></svg>';
    for (const id of ['theme-toggle','bootstrap-theme']) { const button=$(id);button.setAttribute('aria-label',label);button.title=label;button.innerHTML=icon; }
  }
  function toggleTheme() {
    const theme=document.documentElement.dataset.theme==='light'?'dark':'light';
    document.documentElement.dataset.theme=theme;try{localStorage.setItem('pl-ui-theme',theme);}catch{}setTheme();
  }
  $('theme-toggle').addEventListener('click',toggleTheme);
  $('bootstrap-theme').addEventListener('click',toggleTheme);
  window.addEventListener('storage',event=>{if(event.key==='pl-ui-theme'&&['dark','light'].includes(event.newValue)){document.documentElement.dataset.theme=event.newValue;setTheme();}});
  setTheme();

  }

  class APIError extends Error { constructor(message,status=0,code=''){super(message);this.status=status;this.code=code;} }
  async function api(path,options={},timeout=30000) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
    const headers=new Headers(options.headers||{});headers.set('Accept','application/json');
    if(options.method&&options.method!=='GET') { if(!session?.csrf_token){clearTimeout(timer);throw new APIError('Сессия не подтверждена. Войдите через Платформу.',401);}headers.set('X-CSRF-Token',session.csrf_token); }
    try {
      const response=await fetch(path,{...options,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal});
      let payload=null;try{payload=await response.json();}catch{}
      if(!response.ok){const message=response.status===401?'Сессия истекла. Войдите через Платформу.':response.status===403?'Платформа отклонила запрос. Проверьте сессию и повторите.':String(payload?.message||`Не удалось выполнить запрос (${response.status}).`).slice(0,1000);throw new APIError(message,response.status,payload?.error||'');}
      if(payload===null)throw new APIError('Сервер вернул ответ в неизвестном формате.',response.status);
      return payload;
    } catch(error) {
      if(error instanceof APIError)throw error;
      throw new APIError(error.name==='AbortError'?'Сервер не ответил вовремя. Результат операции пока не подтверждён.':'Не удалось связаться с сервером. Проверьте соединение и повторите.');
    } finally {clearTimeout(timer);}
  }
  function normalizeDataset(value) {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new APIError('Неверный формат данных отчёта.');
    const data=value.dataset&&typeof value.dataset==='object'?value.dataset:value;
    const nonempty=ARRAY_KEYS.some(k=>Array.isArray(data[k])&&data[k].length);
    if(nonempty&&CORE_KEYS.some(k=>!Array.isArray(data[k])))throw new APIError('Сервер вернул неполный набор данных. Предыдущий отчёт сохранён.');
    if(nonempty&&(!data.summary||typeof data.summary!=='object'))throw new APIError('В данных отсутствует сводка. Предыдущий отчёт сохранён.');
    for(const key of ARRAY_KEYS){if(data[key]!==undefined&&!Array.isArray(data[key]))throw new APIError('Неверный формат раздела отчёта: '+key);data[key] ||= [];}
    data.summary ||= {rawMissing:0,directMissing:0};
    data.software_count = data.software_count ?? data.softwareTotal ?? data.metadata?.software_count ?? data.software.length;
    return data;
  }
  function date(value) {
    if(!value)return '—';const stamp=typeof value==='number'?value*1000:value;const parsed=new Date(stamp);
    return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function mount(data) {
    reportInstance?.destroy();
    const oldDialog=$('details-dialog');if(oldDialog.open)oldDialog.close();oldDialog.replaceWith(detailsTemplate.cloneNode(true));
    $('report-workspace').innerHTML=reportTemplate;document.querySelector('.tabs').innerHTML=navTemplate;
    document.body.classList.remove('no-scroll');
    reportInstance=window.InventoryReport(data);currentData=data;
    const userName=session.user.name||session.user.id;
    if(window.plInventoryShell) {window.plInventoryShell.setUser({name:userName,subtitle:'Пользователь Платформы'});window.plInventoryShell.setLogoutDisabled(false);}
    else $('current-user-name').textContent=userName;
    const branches=[...new Set(data.sources.map(s=>s.branch).filter(Boolean))];
    $('report-description').textContent=branches.length?branches.join(', ')+' · результаты сбора и пояснения администраторов':'Загрузите первый комплект филиала';
    const snapshots=data.sources.map(s=>s.generated).filter(Boolean).sort();
    $('snapshot-label').textContent=snapshots.length?'Последний снимок: '+date(snapshots.at(-1)):'Снимков пока нет';
    const empty=!data.sources.length;
    $('dataset-empty').hidden=!empty;$('inventory-panel').hidden=empty;document.querySelector('.foot').hidden=empty;
    $('app-shell').hidden=false;$('bootstrap-notice').hidden=true;
  }
  function notice(message,type='info',retry=false) {
    const box=$('app-notice');box.hidden=false;box.className='notice '+(type==='error'?'notice-error':'');box.replaceChildren();
    const text=document.createElement('span');text.textContent=message;box.append(text);
    if(retry){const button=document.createElement('button');button.type='button';button.className=window.PLUI?.buttonClasses ? window.PLUI.buttonClasses({variant:'secondary',className:'source-button'}) : 'source-button';button.id='refresh-data';button.textContent='Обновить отчёт';box.append(button);}
  }
  async function loadDataset() {
    for(let attempt=0;attempt<2;attempt++) {
      const merged={};let page=1,revision=null;
      try {
        while(true) {
          const params=new URLSearchParams({page:String(page)});
          if(revision)params.set('revision',revision);
          const result=await api('/inventory/api/data?'+params.toString(),{},90000);
          if(!result||result.page!==page||typeof result.revision!=='string'||!/^[a-f0-9]{64}$/i.test(result.revision)||!result.dataset||typeof result.dataset!=='object'||Array.isArray(result.dataset))throw new APIError('Сервер вернул неверную страницу отчёта. Предыдущий отчёт сохранён.');
          if(revision&&result.revision!==revision)throw new APIError('Снимок изменился во время загрузки отчёта.',409,'snapshot_changed');
          revision=result.revision;
          for(const key of ARRAY_KEYS)if(!Array.isArray(result.dataset[key]))throw new APIError('Сервер вернул неполную страницу отчёта. Предыдущий отчёт сохранён.');
          for(const [key,value] of Object.entries(result.dataset)) {
            if(Array.isArray(value)) {
              if(merged[key]!==undefined&&!Array.isArray(merged[key]))throw new APIError('Несогласованный формат страниц отчёта.');
              merged[key] ||= [];
              for(const row of value)merged[key].push(row);
            } else {
              if(Array.isArray(merged[key]))throw new APIError('Несогласованный формат страниц отчёта.');
              if(merged[key]===undefined)merged[key]=value;
            }
          }
          if(result.next_page===null)return normalizeDataset(merged);
          if(!Number.isSafeInteger(result.next_page)||result.next_page!==page+1||result.next_page>10000)throw new APIError('Сервер вернул неверную последовательность страниц отчёта. Предыдущий отчёт сохранён.');
          page=result.next_page;
          if(!currentData)$('bootstrap-message').textContent='Загружаем данные филиалов: страница '+page+'…';
        }
      } catch(error) {
        if(attempt===0&&error.status===409&&error.code==='snapshot_changed')continue;
        throw error;
      }
    }
  }
  async function refreshDataset() {
    const data=await loadDataset();mount(data);refreshPending=false;return data;
  }
  function bootError(error) {
    $('bootstrap-notice').hidden=false;$('bootstrap-title').textContent='Не удалось открыть инвентаризацию';$('bootstrap-message').textContent=error.message;
    $('bootstrap-login').hidden=error.status!==401;$('bootstrap-retry').hidden=false;
  }
  async function boot() {
    if(booting)return;booting=true;$('bootstrap-retry').disabled=true;
    try {
      const value=await api('/inventory/api/session');
      if(!value?.user?.id||!value?.csrf_token)throw new APIError('Платформа не подтвердила сессию.',401);
      session=value;$('bootstrap-message').textContent='Загружаем данные филиалов…';
      await refreshDataset();restoreJob();
    } catch(error){bootError(error);}finally{booting=false;$('bootstrap-retry').disabled=false;}
  }
  $('bootstrap-retry').addEventListener('click',boot);

  function saveJob() {
    try{if(importState.jobId||importState.preview)sessionStorage.setItem(STORED_JOB,JSON.stringify({actor:session?.user.id,jobId:importState.jobId,preview:importState.preview,uploadKey:importState.uploadKey,commitKey:importState.commitKey}));else sessionStorage.removeItem(STORED_JOB);}catch{}
  }
  function restoreJob() {
    try {const saved=JSON.parse(sessionStorage.getItem(STORED_JOB)||'null');if(saved&&saved.actor===session.user.id&&typeof saved.jobId==='string'&&saved.jobId.length<200){importState={...importState,...saved,phase:saved.preview?'preview':'paused'};notice('Есть незавершённая проверка комплекта. Откройте загрузку, чтобы продолжить.');}else sessionStorage.removeItem(STORED_JOB);}catch{}
  }
  function importError(error) {$('import-error').textContent=error.message;$('import-error').hidden=false;$('import-login').hidden=error.status!==401;}
  function importStatus(message) {$('import-status').textContent=message;$('import-status').hidden=!message;}
  function busy() {return ['uploading','polling','committing'].includes(importState.phase);}
  function updateImportControls() {
    const phase=importState.phase,locked=busy();
    $('import-submit').disabled=locked;$('import-submit').hidden=Boolean(importState.jobId||importState.preview);
    $('import-commit').hidden=!importState.preview?.preview_id;$('import-commit').disabled=locked;
    $('import-commit').textContent=phase==='committing'?'Публикуем…':'Опубликовать';
    $('import-resume').hidden=!importState.jobId||Boolean(importState.preview)||locked;
    $('import-new').hidden=(!importState.jobId&&!importState.preview);$('import-new').disabled=locked;
    $('import-close').disabled=['uploading','committing'].includes(phase);$('import-cancel').disabled=$('import-close').disabled;
    for(const id of ['workbook-file','archive-file'])$(id).disabled=locked||Boolean(importState.jobId||importState.preview);
  }
  function renderPreview(result) {
    const preview={...result,preview_id:result.preview_id||result.token};importState.preview=preview;importState.phase='preview';importState.commitKey ||= uuid();
    $('import-preview').hidden=false;
    const counts=preview.counts&&typeof preview.counts==='object'?preview.counts:{};
    const fields=[['Филиал',preview.branch||preview.metadata?.branch||'—'],['Кампания',preview.campaign_id||preview.campaignId||preview.metadata?.campaign_id],['Снимок',preview.snapshot_at||preview.generated||preview.metadata?.generated]];
    const names={machines:'Машины',windows:'Машины Windows',software:'Записи ПО',office:'Записи Office',questions:'Вопросы',answers:'Заполненные ответы',priority:'Приоритетное ПО',coverage:'Охват'};
    for(const [key,label] of Object.entries(names)){const count=counts[key];if(typeof count==='number')fields.push([label,count.toLocaleString('ru-RU')]);}
    $('import-preview-fields').innerHTML=fields.filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>`<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('');
    const warnings=Array.isArray(preview.warnings)?preview.warnings:[];
    const messages=warnings.map(w=>typeof w==='string'?w:w.message||w.code||'Проверьте замечания к комплекту.');
    if(preview.duplicate)messages.unshift('Этот комплект уже загружен. Повторная публикация не создаст дубликаты.');
    $('import-warnings').hidden=!messages.length;$('import-warnings').replaceChildren();
    for(const message of messages){const p=document.createElement('p');p.textContent=message;$('import-warnings').append(p);}
    importStatus('Комплект проверен. Проверьте результат перед публикацией.');saveJob();updateImportControls();
  }
  async function pollJob() {
    if(!importState.jobId||busy())return;
    const generation=++pollGeneration;importState.phase='polling';$('import-error').hidden=true;updateImportControls();
    importStatus('Проверяем файлы. Опубликованные данные пока не меняются.');
    const started=Date.now();
    try {
      while(generation===pollGeneration){
        const result=await api('/inventory/api/jobs/'+encodeURIComponent(importState.jobId),{},20000);
        if(generation!==pollGeneration)return;
        if(['succeeded','completed','success'].includes(result.status)){
          if(!result.result||typeof result.result!=='object')throw new APIError('Проверка завершилась без результата. Откройте историю загрузок.');
          renderPreview(result.result);return;
        }
        if(['failed','cancelled'].includes(result.status)){importState.phase='failed';throw new APIError(String(result.message||result.error?.message||result.error||'Не удалось проверить комплект.').slice(0,1000));}
        if(Date.now()-started>90000){importState.phase='paused';importStatus('Проверка ещё выполняется. Можно закрыть окно и продолжить позднее без повторной загрузки.');return;}
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
    } catch(error){if(generation===pollGeneration){if(importState.phase!=='failed')importState.phase='paused';importError(error);importStatus('Файлы повторно отправлять не нужно. Можно продолжить проверку этой задачи.');}}
    finally{if(generation===pollGeneration){if(importState.phase==='polling')importState.phase='paused';saveJob();updateImportControls();}}
  }
  function openImport() {
    if(!session)return;$('import-dialog').showModal();
    if(importState.preview)renderPreview(importState.preview);else if(importState.jobId&&!busy())void pollJob();
    updateImportControls();
  }
  function resetImport() {
    pollGeneration++;importState={phase:'idle',uploadKey:null,commitKey:null,jobId:null,preview:null};
    $('import-form').reset();$('import-preview').hidden=true;$('import-error').hidden=true;$('import-login').hidden=true;importStatus('');saveJob();updateImportControls();
  }
  $('import-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy()||importState.jobId)return;
    const workbook=$('workbook-file').files[0],archive=$('archive-file').files[0];$('import-error').hidden=true;$('import-login').hidden=true;
    if(!workbook||!archive){importError(new APIError('Выберите оба файла комплекта.'));return;}
    if(!/\.xlsx$/i.test(workbook.name)||!/\.zip$/i.test(archive.name)){importError(new APIError('Нужны файл Excel .xlsx и архив .zip.'));return;}
    if(!workbook.size||!archive.size||workbook.size+archive.size>MAX_UPLOAD){importError(new APIError('Файлы должны быть непустыми. Общий размер запроса — не более 64 МиБ.'));return;}
    const body=new FormData();body.append('workbook',workbook);body.append('archive',archive);
    importState.phase='uploading';importState.uploadKey ||= uuid();updateImportControls();importStatus('Отправляем комплект на проверку…');
    try {
      const result=await api('/inventory/api/imports/preview',{method:'POST',headers:{'Idempotency-Key':importState.uploadKey},body},120000);
      if(result.job_id){importState.jobId=String(result.job_id);importState.phase='paused';saveJob();await pollJob();}
      else if(result.preview_id||result.token)renderPreview(result);
      else throw new APIError('Сервер не вернул номер задачи проверки. Повторите отправку тех же файлов.');
    } catch(error){if(!importState.jobId){importState.phase='idle';importError(error);importStatus('Опубликованные данные сохранены. При повторной отправке будет использован тот же ключ операции.');}}
    finally {updateImportControls();}
  });
  for(const id of ['workbook-file','archive-file'])$(id).addEventListener('change',()=>{if(!importState.jobId){importState.uploadKey=null;$('import-error').hidden=true;}});
  $('import-resume').addEventListener('click',()=>void pollJob());
  $('import-new').addEventListener('click',resetImport);
  for(const id of ['import-close','import-cancel'])$(id).addEventListener('click',()=>{if(!['uploading','committing'].includes(importState.phase))$('import-dialog').close();});
  $('import-dialog').addEventListener('cancel',event=>{if(['uploading','committing'].includes(importState.phase))event.preventDefault();});
  $('import-dialog').addEventListener('close',()=>{if(importState.phase==='polling'){pollGeneration++;importState.phase='paused';saveJob();updateImportControls();}});
  $('import-commit').addEventListener('click',async()=>{
    if(busy()||!importState.preview?.preview_id)return;
    importState.phase='committing';importState.commitKey ||= uuid();$('import-error').hidden=true;updateImportControls();importStatus('Публикуем проверенный снимок…');saveJob();
    try {
      await api('/inventory/api/imports/'+encodeURIComponent(importState.preview.preview_id)+'/commit',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':importState.commitKey},body:'{}'},120000);
      importState.phase='committed';$('import-dialog').close();resetImport();
      notice('Комплект опубликован. Обновляем отчёт…');
      try{await refreshDataset();notice('Комплект опубликован. Отчёт обновлён.');}catch(error){refreshPending=true;notice('Комплект опубликован, но обновить экран не удалось. На экране предыдущий снимок. '+error.message,'error',true);}
    } catch(error){importState.phase='preview';importError(error);importStatus('Результат публикации не подтверждён. Повторная публикация использует тот же ключ операции.');saveJob();}
    finally{updateImportControls();}
  });

  async function history() {
    $('history-status').textContent='Загружаем историю…';$('history-content').replaceChildren();$('history-retry').disabled=true;
    try {
      const result=await api('/inventory/api/imports');if(!Array.isArray(result.imports))throw new APIError('Неверный формат истории загрузок.');
      $('history-status').textContent=result.imports.length?'Комплектов: '+result.imports.length:'Комплекты пока не загружены.';
      if(result.imports.length)$('history-content').innerHTML='<div class="history-table-wrap"><table aria-label="История загрузок"><thead><tr><th>Филиал</th><th>Загружено</th><th>Кто загрузил</th><th>Состояние</th></tr></thead><tbody>'+result.imports.map(row=>{const actor=typeof row.actor==='object'?(row.actor?.name||row.actor?.id):row.actor;const status=row.active===true||row.is_active===true?'Текущий снимок':row.status||row.state||'Сохранён';return `<tr><td>${escape(row.branch||row.metadata?.branch||'—')}<div class="secondary">${escape(row.campaign_id||row.campaignId||'')}</div></td><td>${escape(date(row.imported_at||row.created_at||row.committed_at))}</td><td>${escape(actor||row.actor_name||'—')}</td><td>${escape(status)}</td></tr>`;}).join('')+'</tbody></table></div>';
    } catch(error){$('history-status').textContent=error.message;}finally{$('history-retry').disabled=false;}
  }
  $('history-close').addEventListener('click',()=>$('history-dialog').close());$('history-retry').addEventListener('click',()=>void history());
  async function logout(){
    const button=$('logout-button');button.disabled=true;
    try {
      const value=await api('/api/v1/session');const csrf=value.csrf_token||value.csrf;
      if(!csrf)throw new APIError('Платформа не вернула токен выхода.');
      const response=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrf,'Accept':'application/json'},signal:AbortSignal.timeout(8000)});
      if(response.ok||response.status===401){location.assign('/');return;}
      throw new APIError('Не удалось завершить сессию Платформы. Повторите выход.');
    } catch(error){if(error.status===401){location.assign('/');return;}notice(error.message,'error');}finally{button.disabled=false;}
  }
  if(window.plInventoryShell) window.plInventoryLogout=logout;
  else $('logout-button').addEventListener('click',logout);
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(['open-import','empty-import'].includes(button.id)){openImport();return;}
    if(button.id==='open-history'){if(!session)return;$('history-dialog').showModal();void history();return;}
    if(button.id==='refresh-data'){button.disabled=true;try{await refreshDataset();notice('Отчёт обновлён.');}catch(error){notice(error.message,'error',true);}return;}
  });
  void boot();
})();
