window.InventoryReport = function mountInventoryReport(data){
/* Pure grouping model. Counts refer to unique branch + CanonicalId pairs. */
const PriorityGroups = (() => {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const machineIdentity = row => row.branch + '|' + (row.canonical || row.machine);
  const distinct = values => [...new Set(values.filter(Boolean))];
  const compare = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' }).compare;

  function programName(row) {
    const name = normalize(row.product);
    if (row.developer === '1С') {
      if (/7\.7/.test(name)) return '1С:Предприятие 7.7';
      if (/сервер/i.test(name)) return '1С:Предприятие 8 — сервер';
      if (/тонкий клиент|thin client/i.test(name)) return '1С:Предприятие 8 — тонкий клиент';
      return '1С:Предприятие 8 — платформа';
    }
    if (row.developer === 'Лаборатория Касперского') {
      if (/endpoint\s+security/i.test(name)) return 'Kaspersky Endpoint Security';
      if (/агент администрирования|network agent/i.test(name)) return 'Агент Kaspersky Security Center';
    }
    if (row.developer === 'АТОЛ' && /^Драйвер ККТ(?:\s|$)/i.test(name)) return 'Драйвер ККТ';
    if (row.developer === 'АТОЛ' && /^Драйверы торгового оборудования(?:\s|$)/i.test(name)) return 'Драйверы торгового оборудования';
    if (row.developer === 'АСКОН' && /^КОМПАС-3D Viewer\b/i.test(name)) return 'КОМПАС-3D Viewer';
    if (row.developer === 'Яндекс') {
      if (/music|музык/i.test(name)) return 'Яндекс Музыка';
      if (/disk|диск/i.test(name)) return 'Яндекс Диск';
      if (/punto switcher/i.test(name)) return 'Punto Switcher';
      if (/^(?:yandex(?: browser)?|яндекс браузер)(?:\s*\(all users\)| с алисой ai(?:\s*\(all users\))?)?$/i.test(name)) return 'Яндекс Браузер';
    }
    return name
      .replace(/\s*\((?:all users|администратор|administrator|x86-64|x86|x64|\d+[- ]?bit)\)/gi, '')
      .replace(/\s+(?:версия\s+|version\s+|v)?\d+(?:\.\d+){1,}(?:\s+(?:x64|x86))?$/i, '')
      .trim();
  }

  function classify(records) {
    const questions = [...new Map(records.flatMap(r => r.qs || []).map(q => [q.branch + '|' + q.id, q])).values()];
    if (!questions.length) return { status: 'noData', questions, reason: 'Вопрос по этой программе не сформирован.' };
    if (questions.some(q => q.evidence === 'missing')) return { status: 'missing', questions, reason: 'Есть прямой ответ администратора об отсутствии лицензии.' };
    if (questions.some(q => q.evidence === 'conditional')) return { status: 'clarify', questions, reason: 'В ответе есть оговорка или требуется уточнение условий использования.' };
    if (questions.every(q => q.evidence === 'removed')) return { status: 'removed', questions, reason: 'Администратор сообщил об удалении; сведения относятся к снимку сбора.' };
    for (const q of questions) {
      const text = normalize(q.answer + ' ' + q.comment);
      if (/не\s+(?:определ[её]н|подтвержд[её]н|найден)|неизвест|нет\s+сведен/i.test(text)) {
        return { status: 'clarify', questions, reason: 'В ответе указана неопределённость сведений о лицензии.' };
      }
      if (/MAS|не знаю|возможно|устаревш/i.test(text) && !/бессроч/i.test(text)) {
        return { status: 'clarify', questions, reason: 'Пояснение не определяет лицензию этой установки.' };
      }
      const licensedMajor = text.match(/бессроч.*?(?:верси[яию]|версию)\s*(\d+)/i);
      const related = records.filter(r => (r.qs || []).includes(q));
      if (licensedMajor && related.some(r => r.version && r.version.split('.')[0] !== licensedMajor[1])) {
        return { status: 'clarify', questions, reason: 'В ответе указана лицензия на другую основную версию.' };
      }
      if (!/лиценз|бессроч|встроен|интегрирован|ключ|токен|выда[еёю]|выдают/i.test(text)) {
        return { status: 'clarify', questions, reason: 'Ответ получен, но сведений о лицензии в нём недостаточно.' };
      }
    }
    return { status: 'explained', questions, reason: 'Есть содержательное пояснение администратора о лицензировании.' };
  }

  function build(records) {
    const groups = new Map();
    for (const row of records) {
      const product = programName(row);
      const key = row.developer + '|' + product;
      if (!groups.has(key)) groups.set(key, { id: key, product, developer: row.developer, records: [], machines: [] });
      groups.get(key).records.push(row);
    }
    return [...groups.values()].map(group => {
      const machines = new Map();
      for (const row of group.records) {
        const key = machineIdentity(row);
        if (!machines.has(key)) machines.set(key, { key, branch: row.branch, machine: row.machine, canonical: row.canonical, records: [] });
        machines.get(key).records.push(row);
      }
      group.machines = [...machines.values()].map(machine => ({ ...machine, versions: distinct(machine.records.map(r => r.version)).sort(compare), ...classify(machine.records) })).sort((a,b) => compare(a.branch,b.branch) || compare(a.machine,b.machine));
      group.machineCount = group.machines.length;
      group.missingCount = group.machines.filter(m => m.status === 'missing').length;
      group.clarifyCount = group.machines.filter(m => m.status === 'clarify').length;
      group.noDataCount = group.machines.filter(m => m.status === 'noData').length;
      group.explainedCount = group.machines.filter(m => m.status === 'explained').length;
      group.removedCount = group.machines.filter(m => m.status === 'removed').length;
      return group;
    }).sort((a,b) => compare(a.product,b.product) || compare(a.developer,b.developer));
  }
  return { programName, classify, build };
})();

'use strict';

const $=id=>document.getElementById(id);
const collator=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=value=>String(value??'').toLocaleLowerCase('ru').replaceAll('ё','е');
const machineKey=r=>r.branch+'|'+(r.canonical||r.machine);
const productKey=r=>machineKey(r)+'|'+norm(r.product)+'|'+r.version;
const qByMachine=new Map(),qByProduct=new Map(),officeByProduct=new Map(),priorityByProduct=new Map(),records=new Map();
let uid=0;
for(const [table,rows] of Object.entries(data)){if(!Array.isArray(rows))continue;for(const r of rows){r.uid=String(++uid);r.table=table;records.set(r.uid,r);}}
function addIndex(index,key,value){if(!index.has(key))index.set(key,[]);index.get(key).push(value);}
for(const q of data.questions){addIndex(qByMachine,machineKey(q),q);addIndex(qByProduct,machineKey(q)+'|'+norm(q.product),q);}
for(const r of data.office)addIndex(officeByProduct,productKey(r),r);
for(const r of data.catalogPriority)addIndex(priorityByProduct,productKey(r),r);
const russianProducts=new Set(data.priority.map(productKey));
function unique(values){return [...new Set(values.filter(v=>v&&String(v).trim()))];}
function questionRows(r){if(r.table==='questions')return [r];const all=qByMachine.get(machineKey(r))||[];if(r.table==='windows')return all.filter(q=>q.key.startsWith('WindowsActivation.'));let qs=[...(qByProduct.get(machineKey(r)+'|'+norm(r.product))||[])];if(r.table==='priority')qs.push(...all.filter(q=>q.key===r.questionKey));if(r.table==='software'){const keys=new Set((priorityByProduct.get(productKey(r))||[]).map(p=>p.questionKey).filter(Boolean));qs.push(...all.filter(q=>keys.has(q.key)));}return [...new Set(qs)];}
function evidenceOf(qs){return qs.some(q=>q.evidence==='missing')?'missing':qs.some(q=>q.evidence==='conditional')?'conditional':qs.some(q=>q.evidence==='removed')?'removed':'unknown';}
for(const r of [...data.software,...data.priority,...data.office,...data.windows,...data.questions]){r.qs=questionRows(r);r.answer=unique(r.qs.map(q=>q.answer)).join('\n\n');r.comment=unique(r.qs.map(q=>q.comment)).join('\n\n');r.evidence=r.table==='questions'?r.evidence:evidenceOf(r.qs);if(r.table==='software'){const os=officeByProduct.get(productKey(r))||[];r.activationStates=unique(os.map(o=>o.activation));r.activation=r.activationStates.length===1?r.activationStates[0]:r.activationStates.length?'Multiple':'Unavailable';r.priority=russianProducts.has(productKey(r));}r.notactivated=r.activation==='NotActivated'||r.activationStates?.includes('NotActivated');}
const configs={
  licensing:{label:'Лицензии',columns:[['branch','Филиал','10%'],['machine','Компьютер','15%'],['product','Windows','23%'],['evidence','Сведения о лицензии','19%'],['basis','Основания и активация','33%']],category:'ПО',categoryAll:'Все продукты',note:'',foot:'Число машин с прямым ответом об отсутствии лицензии. Ответы только по Teams Add-in и другие оговорки выделены отдельно. Это сведения администраторов, а не документальная сверка прав.'},
  software:{label:'Всё ПО',columns:[['branch','Филиал','9%'],['machine','Компьютер','13%'],['product','Программа','30%'],['version','Версия','12%'],['publisher','Издатель','16%'],['evidence','Лицензия / активация','20%']],category:'Группа ПО',categoryAll:'Все группы',note:'Все строки software.csv, включая компоненты и профили пользователей',foot:'Сохранены все регистрации software.csv. Разные версии, компоненты и записи пользовательских профилей не объединены. Нажмите на программу для просмотра всех её полей.'},
  windows:{label:'Windows',columns:[['branch','Филиал','10%'],['machine','Компьютер','15%'],['product','Операционная система','28%'],['activation','Активация','15%'],['channel','Канал','12%'],['evidence','Сведения о лицензии','20%']],category:'Операционная система',categoryAll:'Все версии Windows',note:'Одна строка — одна машина из machines.csv',foot:'Активация и канал Windows получены автоматически. Даже успешная активация сама по себе не подтверждает наличие права использования.'},
  office:{label:'Office',columns:[['branch','Филиал','9%'],['machine','Компьютер','13%'],['product','Office / Visio / Project','29%'],['version','Версия','12%'],['activation','Активация','15%'],['evidence','Сведения о лицензии','22%']],category:'Продукт',categoryAll:'Все продукты Office',note:'Пакеты, компоненты и регистрации из office.csv',foot:'Строки office.csv сохранены отдельно. Один компьютер может одновременно иметь активированный пакет и компоненты с неизвестным статусом. Строки не равны количеству лицензий.'},
  coverage:{label:'Охват',columns:[['branch','Филиал','10%'],['machine','Компьютер','16%'],['scope','Область опроса','18%'],['result','Результат сбора','20%'],['reason','Причина / пояснение','36%']],category:'Результат сбора',categoryAll:'Все результаты',note:'Одна строка — один объект из листа «Охват»',foot:'Область и результаты опроса приведены по исходным файлам. Нет результата не означает отсутствие программ или лицензий. Устройства вне AD описаны в ответах.'},
  questions:{label:'Ответы',columns:[['branch','Филиал','9%'],['machine','Компьютер','13%'],['product','Продукт / объект','23%'],['answer','Ответ администратора','32%'],['comment','Комментарий','23%']],category:'Раздел',categoryAll:'Все разделы',note:'Все исходные вопросы и заполненные ответы из Excel',foot:'Ответы сопоставлены с исходными вопросами по идентификаторам. Статусы отчёта отделены от исходных формулировок; полный вопрос доступен в строке.'}
};
configs.priority={label:'Приоритетное ПО',columns:[['branch','Филиал','9%'],['machine','Компьютер','13%'],['product','Программа','30%'],['version','Версия','12%'],['family','Разработчик','16%'],['evidence','Сведения о лицензии','20%']],category:'Разработчик',categoryAll:'Все разработчики',note:'',foot:'ПО идентифицированных российских разработчиков из полного software.csv. Сопоставление по издателю и известным названиям продуктов; без вывода о платности и наличии лицензии.'};
const state={view:'licensing',search:'',branch:'',category:'',machine:'',version:'',answer:'',evidence:'',sort:'branch',direction:1,page:1,size:25};
let visibleRows=[];
const categoryOf=(r,view=state.view)=>view==='coverage'?r.result:view==='windows'||view==='office'?r.product:view==='priority'?r.family:r.bucket;
function projection(row){const qs=(qByMachine.get(machineKey(row))||[]).filter(q=>!state.category||q.bucket===state.category);const missing=qs.filter(q=>q.evidence==='missing'),conditional=qs.filter(q=>q.evidence==='conditional'),removed=qs.filter(q=>q.evidence==='removed');const active=[];if(!state.category||state.category==='Windows')active.push(row.activationWindows);if(!state.category||state.category==='Office / Visio / Project')active.push(...row.activationOffice);return {...row,qs,missing,conditional,removed,evidence:evidenceOf(qs),answer:unique(qs.map(q=>q.answer)).join('\n\n'),comment:unique(qs.map(q=>q.comment)).join('\n\n'),basis:unique([...missing,...conditional].map(q=>q.bucket+' · '+q.product)).join('; '),notactivated:active.includes('NotActivated'),categorySelected:state.category};}
function sourceRows(){return state.view==='licensing'?data.licensing.map(projection):data[state.view];}
function evidenceMatches(r){return !state.evidence||(state.evidence==='notactivated'?Boolean(r.notactivated):state.evidence==='conditional'?state.view==='licensing'?r.evidence==='conditional':r.evidence==='conditional':r.evidence===state.evidence);}
function getFiltered(ignoreEvidence=false){if(state.view==='priority')return priorityGroupsFiltered();const tokens=norm(state.search).trim().split(/\s+/).filter(Boolean);return sourceRows().filter(r=>(!state.branch||r.branch===state.branch)&&(!state.category||(state.view==='licensing'?r.groups.includes(state.category)||(r.qs||[]).some(q=>q.bucket===state.category):categoryOf(r)===state.category))&&(!state.machine||machineKey(r)===state.machine)&&(!state.version||r.version===state.version)&&(ignoreEvidence||evidenceMatches(r))&&(!state.answer||(state.answer==='yes'?Boolean(r.answer?.trim()):!r.answer?.trim()))&&(!tokens.length||tokens.every(t=>norm([r.branch,r.machine,r.product,r.version,r.publisher,r.bucket,r.answer,r.comment,r.basis,r.result,r.reason,r.scope,r.channel].join(' ')).includes(t)))).sort((a,b)=>state.direction*collator.compare(a[state.sort]||'',b[state.sort]||'')||collator.compare(a.machine||'',b.machine||'')||collator.compare(a.product||'',b.product||'')||collator.compare(a.version||'',b.version||''));}
function fillSelect(el,items,all,value){el.innerHTML=`<option value="">${esc(all)}</option>`+items.map(([v,label])=>`<option value="${esc(v)}">${esc(label)}</option>`).join('');el.value=items.some(([v])=>v===value)?value:'';return el.value;}
const options=values=>unique(values).sort(collator.compare).map(v=>[v,v]);
function updateOptions(){if(state.view==='software')return;const cfg=configs[state.view];fillSelect($('branch'),options(data.sources.map(s=>s.branch)),'Все филиалы',state.branch);let rows=data[state.view].filter(r=>!state.branch||r.branch===state.branch);const cats=state.view==='licensing'?rows.flatMap(r=>[...r.groups,...(qByMachine.get(machineKey(r))||[]).map(q=>q.bucket)]):rows.map(r=>categoryOf(r));state.category=fillSelect($('category'),options(cats),cfg.categoryAll,state.category);rows=rows.filter(r=>!state.category||(state.view==='licensing'?r.groups.includes(state.category)||(qByMachine.get(machineKey(r))||[]).some(q=>q.bucket===state.category):categoryOf(r)===state.category));const machines=new Map();for(const r of rows)if(r.machine)machines.set(machineKey(r),[machineKey(r),r.machine+(state.branch?'':' · '+r.branch)]);state.machine=fillSelect($('machine'),[...machines.values()].sort((a,b)=>collator.compare(a[1],b[1])),'Все компьютеры',state.machine);rows=rows.filter(r=>!state.machine||machineKey(r)===state.machine);state.version=fillSelect($('version'),options(rows.map(r=>r.version)),'Все версии',state.version);}
function formatDate(value){const date=new Date(value);return Number.isNaN(date.valueOf())?value:date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})+' МСК';}
function activationLabel(value){return ({Activated:'Активирован',NotActivated:'Не активирован',Unknown:'Не определена',Multiple:'Несколько статусов',Unavailable:'Нет данных'})[value]||value||'Нет данных';}
function activationBadge(value){return `<span class="badge ${value==='NotActivated'?'conditional':value==='Activated'?'collected':''}">${esc(activationLabel(value))}</span>`;}
function evidenceBadge(value){const labels={missing:'Указано отсутствие',conditional:'Требует уточнения',removed:'Удалено по ответу',unknown:'Нет прямого подтверждения'};return `<span class="badge ${value==='missing'?'negative':value==='conditional'?'conditional':''}">${labels[value]||labels.unknown}</span>`;}
function machineButton(row){return row.machine?`<button type="button" class="machine-button" data-machine="${esc(machineKey(row))}">${esc(row.machine)}</button>`:'<span class="no-value">По филиалу</span>';}
function renderBasis(r){const list=[...r.missing,...r.conditional];let html=list.length?unique(list.map(q=>q.bucket)).map(v=>`<div class="evidence-item">${esc(v)}</div>`).join(''):'<div class="no-value">Нет прямого ответа об отсутствии лицензии</div>';if(r.notactivated)html+='<div class="secondary">Есть неактивированный Windows / Office</div>';if(r.removed.length)html+='<div class="secondary">Есть сообщение об удалении ПО</div>';return html+`<button type="button" class="view-link" data-machine="${esc(machineKey(r))}">Открыть основания и данные</button>`;}
function renderCell(r,key){if(key==='branch')return `<span class="branch-label">${esc(r.branch)}</span>`;if(key==='machine')return machineButton(r);if(key==='product'){if(state.view==='questions')return `<div class="product-name">${esc(r.product)}</div><div class="secondary">${esc(r.bucket)}</div><button type="button" class="question-toggle" data-question="${r.uid}" aria-expanded="false">Показать вопрос</button><div class="question-copy" hidden>${esc(r.question)}</div>`;if(state.view==='licensing')return `<div>${esc(r.product)}</div>`;return `<button type="button" class="product-button" data-record="${r.uid}">${esc(r.product)||'Название не указано'}</button>`+(state.view==='software'?`<div class="secondary">${esc(r.bucket)}${r.priority?' · приоритетное ПО':''}</div><div class="scope-label">${r.scope==='User'?'Профиль пользователя':'Машинная установка'}</div>`:'');}if(key==='version')return `<span class="version">${esc(r.version)||'—'}</span>`;if(key==='activation')return activationBadge(r.activation)+(r.channel?`<div class="secondary">${esc(r.channel)}</div>`:'');if(key==='evidence'){let html=evidenceBadge(r.evidence);if(state.view!=='licensing'&&r.answer?.trim())html+=`<div class="secondary answer-text">${esc(r.answer)}</div>`;if(state.view==='software'&&r.activation&&r.activation!=='Unavailable')html+=`<div class="secondary">Активация: ${esc(activationLabel(r.activation))}</div>`;if(state.view==='licensing'&&r.evidence==='conditional')html+='<div class="secondary">Основание только по компоненту или с оговоркой</div>';return html;}if(key==='basis')return renderBasis(r);if(key==='result')return `<span class="badge ${r.result==='Базовые данные собраны'?'collected':r.result==='Нет результата'?'missing':''}">${esc(r.result)}</span>`+(r.collected?`<div class="secondary">${esc(formatDate(r.collected))}</div>`:'');if(key==='answer'||key==='comment')return r[key]?.trim()?`<div class="answer-text">${esc(r[key])}</div>`:'<span class="no-value">—</span>';return esc(r[key])||'<span class="no-value">—</span>';}
function render(){if(state.view==='software'){void renderSoftwarePage();return;}if($('software-status'))$('software-status').hidden=true;if(state.view==='priority'){renderPriority();return;}$('detail-hint').textContent='Нажмите на компьютер или программу для просмотра подробностей';const cfg=configs[state.view];visibleRows=getFiltered();const size=state.size==='all'?Math.max(visibleRows.length,1):state.size,pages=Math.max(Math.ceil(visibleRows.length/size),1);state.page=Math.min(state.page,pages);const from=(state.page-1)*size,rows=visibleRows.slice(from,from+size);$('columns').innerHTML=cfg.columns.map(c=>`<col style="width:${c[2]}">`).join('');$('table-head').innerHTML='<tr>'+cfg.columns.map(([key,title])=>`<th scope="col" aria-sort="${state.sort===key?(state.direction===1?'ascending':'descending'):'none'}"><button type="button" class="sort" data-sort="${key}">${esc(title)}${state.sort===key?`<span class="sort-arrow" aria-hidden="true">${state.direction===1?'↑':'↓'}</span>`:''}</button></th>`).join('')+'</tr>';$('table-body').innerHTML=rows.map(r=>'<tr>'+cfg.columns.map(([key])=>'<td>'+renderCell(r,key)+'</td>').join('')+'</tr>').join('');$('empty').hidden=visibleRows.length>0;const countMachines=new Set(visibleRows.map(machineKey)).size;$('results').textContent=state.view==='licensing'?`Машин: ${visibleRows.length} из ${data.licensing.length}`:`Найдено записей: ${visibleRows.length.toLocaleString('ru-RU')} из ${data[state.view].length.toLocaleString('ru-RU')} · машин: ${countMachines}`;$('page-status').textContent=visibleRows.length?`${from+1}–${from+rows.length} из ${visibleRows.length.toLocaleString('ru-RU')}`:'0 записей';$('previous').disabled=state.page<=1;$('next').disabled=state.page>=pages;$('clear-search').hidden=!state.search;$('table-note').textContent=cfg.note;$('foot-note').textContent=cfg.foot;$('license-summary').hidden=state.view!=='licensing';$('summary-context').hidden=state.view!=='licensing';if(state.view==='licensing'){const base=getFiltered(true);$('missing-count').textContent=base.filter(r=>r.evidence==='missing').length;$('conditional-count').textContent=base.filter(r=>r.evidence==='conditional').length;$('activation-count').textContent=base.filter(r=>r.notactivated).length;for(const b of document.querySelectorAll('[data-preset]'))b.setAttribute('aria-pressed',String(state.evidence===b.dataset.preset));}}
function changeView(view){softwarePageSizes(view);state.view=view;state.category='';state.version='';state.answer='';state.evidence='';state.page=1;state.sort=view==='priority'?'product':'branch';state.direction=1;$('answer').value='';$('evidence').innerHTML=view==='priority'?'<option value="">Все сведения</option><option value="missing">Указано отсутствие</option><option value="conditional">Нужно уточнить</option><option value="noData">Нет сведений</option><option value="explained">Есть пояснение</option>':'<option value="">Все сведения</option><option value="missing">Указано отсутствие</option><option value="conditional">Требует уточнения</option><option value="unknown">Нет прямого подтверждения</option><option value="removed">Удалено по ответу</option><option value="notactivated">Не активирован Windows / Office</option>';$('evidence').value='';for(const t of document.querySelectorAll('[data-view]')){const selected=t.dataset.view===view;t.setAttribute('aria-selected',String(selected));t.tabIndex=selected?0:-1;}$('inventory-panel').setAttribute('aria-labelledby','tab-'+view);$('category-label').textContent=configs[view].category;$('version-field').hidden=!['software','office','windows'].includes(view);$('answer-field').hidden=['coverage','licensing','priority'].includes(view);$('evidence-field').hidden=view==='coverage';updateOptions();render();}
function reset(){for(const k of ['search','branch','category','machine','version','answer','evidence'])state[k]='';state.page=1;$('search').value='';$('answer').value='';$('evidence').value='';updateOptions();render();}
const dialog=$('details-dialog');
function showDialog(title,subtitle,html){$('dialog-title').textContent=title;$('dialog-subtitle').textContent=subtitle;$('dialog-body').innerHTML=html;dialog.showModal();document.body.classList.add('no-scroll');}
const fieldNames={Fqdn:'FQDN',Domain:'Домен',CollectionStatus:'Состояние сбора',CollectedAtUtc:'Дата сбора UTC',IPAddresses:'IP-адреса',MachineType:'Тип машины',Virtualization:'Виртуализация',VmHost:'Хост ВМ',Manufacturer:'Производитель',Model:'Модель',CpuSockets:'CPU: сокеты',CpuCores:'CPU: ядра',LogicalProcessors:'Логические процессоры',TopologyScope:'Область CPU',WindowsCaption:'Windows',WindowsVersion:'Версия Windows',WindowsBuild:'Сборка Windows',WindowsEdition:'Редакция Windows',WindowsArchitecture:'Архитектура Windows',WindowsActivation:'Активация Windows',WindowsChannel:'Канал Windows',ServerRoles:'Роли сервера',SourceRecordIds:'ID исходных записей',IdentityNote:'Пояснение идентификации',Name:'Название',Version:'Версия',Publisher:'Издатель',InstallDate:'Дата установки',Scope:'Область установки',UserSid:'SID профиля',Architecture:'Архитектура',InstallLocation:'Путь установки',Source:'Источник обнаружения',Product:'Продукт',Edition:'Редакция',InstallType:'Тип установки',ProductId:'Идентификатор продукта',LicenseChannel:'Канал лицензирования',ActivationStatus:'Статус активации',InstallationEvidence:'Подтверждение установки',RussianDeveloper:'Российский разработчик',DeveloperReference:'Сведения о разработчике',Section:'Раздел сбора',Status:'Статус',Message:'Сообщение',RecordId:'ID записи',AttemptedAtUtc:'Попытка сбора UTC',Transport:'Транспорт',Reason:'Причина',ErrorCode:'Код ошибки',Instance:'Экземпляр',Host:'Хост',VmName:'Имя ВМ',State:'Состояние ВМ',Relationship:'Связь'};
function detailsGrid(details){return '<dl class="details-grid">'+Object.entries(details||{}).map(([k,v])=>`<dt>${esc(fieldNames[k]||k)}</dt><dd>${esc(v)}</dd>`).join('')+'</dl>';}
function provenance(r){return `<div class="secondary source-file">${esc(r.sourceTable||'Вопросы')} · строка ${r.sourceRow} · ${esc(r.source)}</div>`;}
function questionCard(q){return `<div class="details-item"><strong>${esc(q.product)}</strong><div style="margin-top:7px">${evidenceBadge(q.evidence)}</div>${q.assessmentNote?`<p class="secondary">${esc(q.assessmentNote)}</p>`:''}<details><summary class="secondary">Исходный вопрос</summary><p class="secondary">${esc(q.question)}</p></details><p>${esc(q.answer)||'Ответ не заполнен'}</p>${q.comment?.trim()?`<p class="secondary">Комментарий: ${esc(q.comment)}</p>`:''}${provenance(q)}</div>`;}
function showRecord(id){const r=records.get(id);if(!r)return;const qs=r.qs||[];const catalog=priorityByProduct.get(productKey(r))||[];let html=`<p class="dialog-caption">${esc(r.bucket||'')} · ${esc(r.version)||'Версия не указана'}</p>`;if(r.activation&&r.activation!=='Unavailable')html+=`<h3>Автоматическая активация</h3>${activationBadge(r.activation)}<p class="secondary">Состояние активации отображается отдельно от сведений о лицензии.</p>`;html+='<h3>Сведения из CSV</h3>'+detailsGrid(r.details)+provenance(r);if(catalog.length)html+='<h3>Данные каталога сборщика</h3>'+catalog.map(c=>'<div class="details-item">'+detailsGrid(c.details)+provenance(c)+'</div>').join('');html+='<h3>Ответы по этому продукту</h3>'+(qs.length?qs.map(questionCard).join(''):'<p class="secondary">Прямого ответа администратора по этой записи нет. Наличие лицензии по этим данным не определено.</p>');html+=`<button type="button" class="source-button pl-ui-button pl-ui-button-secondary" style="margin-top:20px" data-open-machine="${esc(machineKey(r))}">Все данные компьютера</button>`;showDialog(r.product,r.branch+' · '+r.machine,html);}
function showMachine(key){const machine=data.windows.find(r=>machineKey(r)===key);const coverage=data.coverage.find(r=>machineKey(r)===key);const qs=qByMachine.get(key)||[];const ref=machine||coverage||qs[0];if(!ref)return;const software=data.software.filter(r=>machineKey(r)===key),office=data.office.filter(r=>machineKey(r)===key),extra=[...data.servers,...data.virtualization].filter(r=>machineKey(r)===key),sections=data.sections.filter(r=>machineKey(r)===key),attempts=data.attempts.filter(r=>r.branch===ref.branch&&norm(r.machine)===norm(ref.machine));let html='';if(coverage)html+='<h3>Охват</h3>'+detailsGrid({'Status':coverage.result,'Scope':coverage.scope,'Reason':coverage.reason,'Transport':coverage.transport,'CollectedAtUtc':coverage.collected});if(machine)html+='<details class="machine-group"><summary>Windows и данные компьютера</summary><div style="margin-top:15px">'+detailsGrid(machine.details)+provenance(machine)+'</div></details>';const negative=qs.filter(q=>['missing','conditional','removed'].includes(q.evidence)),other=qs.filter(q=>!negative.includes(q));html+='<h3>Основания по лицензиям</h3>'+(negative.length?negative.map(questionCard).join(''):'<p class="secondary">Прямых сообщений об отсутствии лицензии нет. Это не подтверждение наличия лицензий.</p>');if(other.length)html+=`<details class="machine-group"><summary>Остальные ответы администратора (${other.length})</summary>${other.map(questionCard).join('')}</details>`;html+=`<h3>Все обнаруженное ПО</h3><p class="dialog-caption">Включая машинные установки и регистрации в профилях пользователей.</p><button type="button" class="source-button pl-ui-button pl-ui-button-secondary" data-open-software="${esc(key)}">Открыть полный список ПО этого компьютера</button>`;if(office.length)html+=`<details class="machine-group"><summary>Office / Visio / Project: активация и компоненты (${office.length})</summary>${office.map(r=>`<div class="details-item"><button type="button" class="product-button" data-record="${r.uid}">${esc(r.product)}</button><div class="secondary">${esc(r.version)||'Версия не указана'} · ${esc(activationLabel(r.activation))} · ${esc(r.channel)}</div></div>`).join('')}</details>`;if(extra.length)html+=`<details class="machine-group"><summary>Серверные продукты и виртуализация (${extra.length})</summary>${extra.map(r=>`<div class="details-item">${detailsGrid(r.details)}${provenance(r)}</div>`).join('')}</details>`;if(sections.length)html+=`<details class="machine-group"><summary>Полнота разделов сбора (${sections.length})</summary>${sections.map(r=>`<div class="details-item">${detailsGrid(r.details)}</div>`).join('')}</details>`;if(attempts.length)html+=`<details class="machine-group"><summary>Попытки сбора (${attempts.length})</summary>${attempts.map(r=>`<div class="details-item">${detailsGrid(r.details)}</div>`).join('')}</details>`;showDialog(ref.machine,ref.branch,html);}
$('sources-button').addEventListener('click',()=>showDialog('Источники и правила подсчёта','Источники опубликованных снимков',`<p class="dialog-caption">Опубликованы данные из ${data.sources.length} комплектов Source.zip и Admin.xlsx. Ответы взяты из заполненных Excel; исходные наблюдения — из CSV архивов.</p>${data.sources.map(s=>`<div class="details-item"><strong>${esc(s.branch)}</strong><div class="source-file">${esc(s.archive)}</div><div class="source-file">${esc(s.name)}</div><div class="secondary">Сформировано: ${esc(formatDate(s.generated))}</div></div>`).join('')}<h3>Что включено</h3><p class="secondary">${Number(data.software_count??data.software.length).toLocaleString('ru-RU')} строк software.csv, ${data.windows.length} машин и их Windows, ${data.office.length} строк office.csv. Приоритетные продукты связаны с полным перечнем. Данные серверных продуктов, виртуализации, разделов и попыток сбора доступны в карточках компьютеров. Все ${data.questions.length} ответов администратора сохранены.</p><h3>Приоритетное ПО</h3><p class="secondary">${data.priority.length} регистраций ПО российских разработчиков объединены в ${PriorityGroups.build(data.priority).length} программ. Машины считаются отдельно внутри каждой программы; версии и компьютеры раскрываются по клику. Неполный ответ или оговорка требуют уточнения, отсутствие сформированного вопроса показано как отсутствие сведений. Русский язык интерфейса сам по себе не является критерием. Компоненты иностранных разработчиков в поставках российских интеграторов не включены. Это классификация по разработчику, а не проверка реестра российского ПО.</p><p class="secondary">Справочные источники: ${data.developerReferences.map(d=>`<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>`).join(', ')}.</p><h3>Как считаются машины</h3><p class="secondary">Уникальность: филиал + CanonicalId. В основном счётчике — машины с прямым ответом об отсутствии лицензии по продукту. Ответы только по Teams Add-in и ответы с оговоркой о токенах требуют уточнения. Удалённые по сообщению администратора программы не добавляют машину в основной счётчик.</p><p class="secondary">Всего явный отрицательный ответ есть на ${data.summary.rawMissing} машинах; на ${data.summary.directMissing} есть прямое основание по продукту. Оговорки по компонентам, токенам, демонстрационному режиму и намерениям удалить ПО показаны отдельно. Если выбрать группу ПО, основания и счётчики пересчитываются только для этой группы. Одна машина с несколькими проблемами считается один раз.</p><h3>Активация и отсутствие сведений</h3><p class="secondary">Неактивированный Windows или Office — отдельный технический признак. Он не означает автоматически отсутствие лицензии. Unknown по компоненту Office не отменяет активацию основного пакета. Наличие Adobe или другого ПО в software.csv не подтверждает ни наличие, ни отсутствие лицензии.</p><p class="secondary">Ключи и фрагменты ключей активации в HTML не включены. Без реестра приобретённых прав документально подтверждённый лицензионный баланс не определяется.</p>`));
$('close-dialog').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>document.body.classList.remove('no-scroll'));dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
$('dialog-body').addEventListener('click',e=>{const record=e.target.closest('[data-record]');if(record){dialog.close();showRecord(record.dataset.record);return;}const machine=e.target.closest('[data-open-machine]');if(machine){dialog.close();showMachine(machine.dataset.openMachine);return;}const software=e.target.closest('[data-open-software]');if(software){const key=software.dataset.openSoftware,r=[...data.windows,...data.coverage,...data.questions].find(r=>machineKey(r)===key);dialog.close();reset();changeView('software');state.machine=key;if(r)state.branch=r.branch;updateOptions();render();}});
document.querySelector('.tabs').addEventListener('click',e=>{const t=e.target.closest('[data-view]');if(t)changeView(t.dataset.view);});document.querySelector('.tabs').addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('[data-view]')],i=tabs.indexOf(e.target);if(i<0)return;let next;if((e.key==='ArrowRight'||e.key==='ArrowDown'))next=(i+1)%tabs.length;if((e.key==='ArrowLeft'||e.key==='ArrowUp'))next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();changeView(tabs[next].dataset.view);tabs[next].focus();}});
$('search').addEventListener('input',e=>{state.search=e.target.value;state.page=1;render();});$('clear-search').addEventListener('click',()=>{state.search='';$('search').value='';state.page=1;render();$('search').focus();});for(const key of ['branch','category','machine','version','answer','evidence'])$(key).addEventListener('change',e=>{state[key]=e.target.value;state.page=1;updateOptions();render();});$('reset').addEventListener('click',reset);$('empty-reset').addEventListener('click',reset);$('page-size').addEventListener('change',e=>{state.size=e.target.value==='all'?'all':Number(e.target.value);state.page=1;render();});$('previous').addEventListener('click',()=>{state.page--;render();});$('next').addEventListener('click',()=>{state.page++;render();});$('table-head').addEventListener('click',e=>{const b=e.target.closest('[data-sort]');if(!b)return;if(state.sort===b.dataset.sort)state.direction*=-1;else{state.sort=b.dataset.sort;state.direction=1;}state.page=1;render();});$('table-body').addEventListener('click',e=>{const group=e.target.closest('[data-group]');if(group){const id=group.dataset.group;if(expandedPriority.has(id))expandedPriority.delete(id);else expandedPriority.add(id);renderPriority();[...document.querySelectorAll('[data-group]')].find(b=>b.dataset.group===id)?.focus();return;}const machine=e.target.closest('[data-machine]');if(machine){showMachine(machine.dataset.machine);return;}const record=e.target.closest('[data-record]');if(record){showRecord(record.dataset.record);return;}const q=e.target.closest('[data-question]');if(q){const copy=q.nextElementSibling;copy.hidden=!copy.hidden;q.setAttribute('aria-expanded',String(!copy.hidden));q.textContent=copy.hidden?'Показать вопрос':'Скрыть вопрос';}});
document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{state.evidence=state.evidence===button.dataset.preset?'':button.dataset.preset;$('evidence').value=state.evidence;state.page=1;render();}));

const expandedPriority = new Set();
let shownPriorityGroups = new Map();
const reviewLabels = { missing:'Указано отсутствие', clarify:'Нужно уточнить', explained:'Есть пояснение', noData:'Нет сведений', removed:'Удалено по ответу' };
const groupElementId=group=>'priority-detail-'+encodeURIComponent(group.id);
function priorityBadge(status){return `<span class="badge ${status==='missing'?'negative':status==='clarify'?'conditional':''}">${reviewLabels[status]||reviewLabels.noData}</span>`;}
function priorityGroupsFiltered(){
  const tokens=norm(state.search).trim().split(/\s+/).filter(Boolean);
  const rows=data.priority.filter(r=>(!state.branch||r.branch===state.branch)&&(!state.category||r.developer===state.category)&&(!state.machine||machineKey(r)===state.machine)&&(!tokens.length||tokens.every(t=>norm([PriorityGroups.programName(r),r.product,r.machine,r.branch,r.developer,r.version,r.answer,r.comment].join(' ')).includes(t))));
  let groups=PriorityGroups.build(rows);
  if(state.evidence)groups=groups.filter(g=>state.evidence==='missing'?g.missingCount>0:state.evidence==='conditional'?g.clarifyCount>0:state.evidence==='noData'?g.noDataCount>0:state.evidence==='explained'?g.explainedCount>0:state.evidence==='removed'?g.removedCount>0:true);
  const numeric=new Set(['machineCount','missingCount','clarifyCount','noDataCount']);
  return groups.sort((a,b)=>state.direction*(numeric.has(state.sort)?a[state.sort]-b[state.sort]:collator.compare(a[state.sort]||a.product,b[state.sort]||b.product))||collator.compare(a.product,b.product));
}
function priorityMachineDetail(machine){
  const answers=machine.questions.map(q=>`<div class="details-item"><strong>${esc(q.product)}</strong><div class="answer-text">${esc(q.answer)||'Ответ не заполнен'}</div>${q.comment?.trim()?`<div class="secondary answer-text">${esc(q.comment)}</div>`:''}${q.assessmentNote?`<div class="secondary">${esc(q.assessmentNote)}</div>`:''}</div>`).join('');
  const registrations=machine.records.map(r=>`<div class="details-item"><button type="button" class="version-button" data-record="${r.uid}">${esc(r.product)}${r.version?' · '+esc(r.version):''}</button>${r.details?.Architecture?`<div class="secondary">${esc(r.details.Architecture)}</div>`:''}</div>`).join('');
  return `<tr><td><span class="branch-label">${esc(machine.branch)}</span></td><td>${machineButton(machine)}</td><td>${esc(machine.versions.join(', '))||'Версия не указана'}<details><summary>Регистрации: ${machine.records.length}</summary>${registrations}</details></td><td><div class="group-state">${priorityBadge(machine.status)}</div>${machine.status==='noData'?'':`<div class="secondary">${esc(machine.reason)}</div>`}</td><td>${answers||'<span class="no-value">Вопрос по этой программе не сформирован.</span>'}</td></tr>`;
}
function priorityGroupDetail(group){
  return `<tr class="group-details" id="${esc(groupElementId(group))}"><td colspan="6"><div class="group-inner"><p class="group-explanation">${esc(group.product)} · машин: ${group.machineCount} · регистраций: ${group.records.length}</p><div class="group-table-wrap"><table class="group-table" aria-label="Компьютеры: ${esc(group.product)}"><colgroup><col style="width:10%"><col style="width:14%"><col style="width:25%"><col style="width:18%"><col style="width:33%"></colgroup><thead><tr><th scope="col">Филиал</th><th scope="col">Компьютер</th><th scope="col">Версии</th><th scope="col">Сведения о лицензии</th><th scope="col">Ответ администратора</th></tr></thead><tbody>${group.machines.map(priorityMachineDetail).join('')}</tbody></table></div></div></td></tr>`;
}
function renderPriority(){
  const groups=priorityGroupsFiltered();visibleRows=groups;shownPriorityGroups=new Map(groups.map(g=>[g.id,g]));
  const columns=[['product','Программа','31%'],['developer','Разработчик','19%'],['machineCount','Машин','10%'],['missingCount','Указано отсутствие','14%'],['clarifyCount','Нужно уточнить','13%'],['noDataCount','Нет сведений','13%']];
  const size=state.size==='all'?Math.max(groups.length,1):state.size,pages=Math.max(Math.ceil(groups.length/size),1);state.page=Math.min(state.page,pages);const from=(state.page-1)*size,page=groups.slice(from,from+size);
  $('columns').innerHTML=columns.map(c=>`<col style="width:${c[2]}">`).join('');
  $('table-head').innerHTML='<tr>'+columns.map(([key,label])=>`<th scope="col" class="${['machineCount','missingCount','clarifyCount','noDataCount'].includes(key)?'numeric':''}" aria-sort="${state.sort===key?(state.direction===1?'ascending':'descending'):'none'}"><button type="button" class="sort" data-sort="${key}">${label}${state.sort===key?`<span aria-hidden="true">${state.direction===1?'↑':'↓'}</span>`:''}</button></th>`).join('')+'</tr>';
  $('table-body').innerHTML=page.map(g=>`<tr data-program-row><td><button type="button" class="group-toggle" data-group="${esc(g.id)}" aria-expanded="${expandedPriority.has(g.id)}" aria-controls="${esc(groupElementId(g))}"><span class="chevron" aria-hidden="true">▸</span>${esc(g.product)}</button></td><td>${esc(g.developer)}</td><td class="numeric">${g.machineCount}</td><td class="numeric ${g.missingCount?'number-missing':''}">${g.missingCount}</td><td class="numeric ${g.clarifyCount?'number-clarify':''}">${g.clarifyCount}</td><td class="numeric">${g.noDataCount}</td></tr>${expandedPriority.has(g.id)?priorityGroupDetail(g):''}`).join('');
  const machines=new Set(groups.flatMap(g=>g.machines.map(m=>m.key)));
  $('results').textContent=`Программ: ${groups.length} · машин: ${machines.size}`;
  $('page-status').textContent=groups.length?`${from+1}–${from+page.length} из ${groups.length}`:'0 программ';
  $('previous').disabled=state.page<=1;$('next').disabled=state.page>=pages;$('empty').hidden=groups.length>0;$('clear-search').hidden=!state.search;$('table-note').textContent='';
  $('foot-note').textContent='Числа относятся к уникальным машинам внутри программы. «Нужно уточнить» — вопрос есть, но ответ неполный или с оговоркой; «Нет сведений» — вопрос не сформирован. Пояснение администратора не является документальным подтверждением лицензии.';
  $('license-summary').hidden=true;$('summary-context').hidden=true;$('detail-hint').textContent='Нажмите на программу, чтобы раскрыть компьютеры и версии';
}
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
  if(error){const button=document.createElement('button');button.type='button';button.className=window.PLUI?.buttonClasses ? window.PLUI.buttonClasses({variant:'secondary',className:'source-button'}) : 'source-button';button.textContent='Повторить';button.addEventListener('click',()=>void renderSoftwarePage());box.append(button);}
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

for(const [view,cfg] of Object.entries(configs)){$('count-'+view).textContent=(view==='priority'?PriorityGroups.build(data.priority).length:view==='software'?Number(data.software_count??data.software.length):data[view].length).toLocaleString('ru-RU');}
changeView('priority');

return {destroy(){softwareRequest?.abort();softwareSequence++;}};
};
