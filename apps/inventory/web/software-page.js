/* Bundled into report.js; the server owns software filtering and paging. */
let softwareRequest = null;
let softwareSequence = 0;
let softwareCache = null;
let softwareRecordIds = [];
function softwarePageSizes(view) {
  const options=view==='software'?'<option>25</option><option>50</option><option>100</option>':'<option>25</option><option>50</option><option>100</option><option value="all">Все</option>';
  $('page-size').innerHTML=options;
  if(view==='software'&&state.size==='all')state.size=25;
  $('page-size').value=String(state.size);
  if(view!=='software'){softwareRequest?.abort();softwareSequence++;}
}
function softwareNotice(message,error=false) {
  let box=$('software-status');
  if(!box){box=document.createElement('div');box.id='software-status';box.setAttribute('role','status');box.className='notice software-status';document.querySelector('.table-shell').before(box);}
  box.hidden=!message;box.className='notice software-status'+(error?' notice-error':'');box.replaceChildren();
  if(message){const text=document.createElement('span');text.textContent=message;box.append(text);}
  if(error){const button=document.createElement('button');button.type='button';button.className='source-button';button.textContent='Повторить';button.addEventListener('click',()=>void renderSoftwarePage());box.append(button);}
}
function softwareHead() {
  const cfg=configs.software;
  $('columns').innerHTML=cfg.columns.map(c=>`<col style="width:${c[2]}">`).join('');
  $('table-head').innerHTML='<tr>'+cfg.columns.map(([key,title])=>`<th scope="col" aria-sort="${state.sort===key?(state.direction===1?'ascending':'descending'):'none'}"><button type="button" class="sort" data-sort="${key}">${esc(title)}${state.sort===key?`<span class="sort-arrow" aria-hidden="true">${state.direction===1?'↑':'↓'}</span>`:''}</button></th>`).join('')+'</tr>';
}
function softwareOptions(response) {
  const before=[state.category,state.machine,state.version].join('\u001f');
  fillSelect($('branch'),options(data.sources.map(s=>s.branch)),'Все филиалы',state.branch);
  const opts=response.options||{};
  state.category=fillSelect($('category'),options(Array.isArray(opts.categories)?opts.categories:[]),'Все группы',state.category);
  const machines=(Array.isArray(opts.machines)?opts.machines:[]).map(m=>typeof m==='string'?[m,m]:[m.value,m.label]).filter(m=>typeof m[0]==='string'&&typeof m[1]==='string');
  state.machine=fillSelect($('machine'),machines,'Все компьютеры',state.machine);
  state.version=fillSelect($('version'),options(Array.isArray(opts.versions)?opts.versions:[]),'Все версии',state.version);
  return before!==[state.category,state.machine,state.version].join('\u001f');
}
function softwareDraw(response) {
  for(const id of softwareRecordIds)records.delete(id);softwareRecordIds=[];
  data.software=response.rows.map(row=>{
    const r={...row,table:'software',uid:'remote-software-'+(++uid)};r.qs=questionRows(r);records.set(r.uid,r);softwareRecordIds.push(r.uid);return r;
  });
  softwareHead();
  $('table-body').innerHTML=data.software.map(r=>'<tr>'+configs.software.columns.map(([key])=>'<td>'+renderCell(r,key)+'</td>').join('')+'</tr>').join('');
  visibleRows=data.software;
  const total=response.total,limit=response._limit||Number(state.size)||25,from=((response._page||state.page)-1)*limit;
  $('results').textContent=`Найдено записей: ${total.toLocaleString('ru-RU')} · машин: ${response.machine_count.toLocaleString('ru-RU')}`;
  $('page-status').textContent=total?`${from+1}–${Math.min(from+data.software.length,total)} из ${total.toLocaleString('ru-RU')}`:'0 записей';
  $('previous').disabled=state.page<=1;$('next').disabled=from+data.software.length>=total;
  $('empty').hidden=total>0;
}
async function renderSoftwarePage() {
  if(state.view!=='software')return;
  softwareRequest?.abort();const sequence=++softwareSequence;const request=new AbortController();softwareRequest=request;
  const timer=setTimeout(()=>request.abort('timeout'),60000);
  $('license-summary').hidden=true;$('summary-context').hidden=true;$('clear-search').hidden=!state.search;
  $('table-note').textContent='';$('foot-note').textContent=configs.software.foot;
  $('detail-hint').textContent='Нажмите на программу или компьютер для просмотра подробностей';
  if(!softwareCache){softwareHead();$('table-body').replaceChildren();$('results').textContent='Загружаем список ПО…';$('page-status').textContent='';$('previous').disabled=true;$('next').disabled=true;$('empty').hidden=true;}
  else softwareDraw(softwareCache);
  $('previous').disabled=true;$('next').disabled=true;
  softwareNotice(softwareCache?'Обновляем список. Пока показаны данные предыдущего запроса.':'Загружаем список ПО…');
  const params=new URLSearchParams();
  for(const key of ['page','search','branch','category','machine','version','evidence','answer','sort','direction'])params.set(key,String(state[key]??''));
  params.set('limit',String(state.size==='all'?25:state.size));
  try {
    const response=await fetch('/inventory/api/software?'+params.toString(),{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:request.signal});
    let result=null;try{result=await response.json();}catch{}
    if(sequence!==softwareSequence||state.view!=='software')return;
    if(!response.ok)throw new Error(response.status===401?'Сессия истекла. Войдите через Платформу.':String(result?.message||`Не удалось загрузить ПО (${response.status}).`).slice(0,1000));
    if(!result||!Array.isArray(result.rows)||!Number.isSafeInteger(result.total)||result.total<0||!Number.isSafeInteger(result.machine_count)||result.machine_count<0)throw new Error('Сервер вернул неверный формат списка ПО.');
    if(softwareOptions(result)){state.page=1;void renderSoftwarePage();return;}
    if(result.total>0&&(state.page-1)*Number(state.size)>=result.total){state.page=Math.ceil(result.total/Number(state.size));void renderSoftwarePage();return;}
    result._page=state.page;result._limit=Number(state.size);softwareCache=result;softwareDraw(result);softwareNotice('');
    $('count-software').textContent=Number(data.software_count??result.total).toLocaleString('ru-RU');
  } catch(error) {
    if(sequence!==softwareSequence||state.view!=='software')return;
    if(error.name==='AbortError'&&request.signal.reason!=='timeout')return;
    if(!softwareCache){$('results').textContent='Данные ПО недоступны';$('empty').hidden=true;}
    softwareNotice((softwareCache?'Показаны данные предыдущего запроса. ':'')+(request.signal.reason==='timeout'?'Сервер не ответил вовремя. Повторите запрос.':error.message||'Не удалось связаться с сервером.'),true);
  } finally {clearTimeout(timer);}
}
