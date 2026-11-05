'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const JSON_MAX_BYTES = 3 * 1024 * 1024;
  const removedNote = 'Это развлекательный тест: результат — игровой образ, а не психологическая оценка.';
  const cleanDescription = value => (value || '').replace(removedNote,'').trim();
  const node = (tag, attrs = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'class') element.className = value;
      else if (value !== false && value != null) element.setAttribute(key, value === true ? '' : value);
    }
    if (element.classList && element.classList.contains('panel')) element.classList.add('pl-ui-panel');
    if (element.classList && element.classList.contains('field')) element.classList.add('pl-ui-field');
    if (element.classList && tag === 'input' && !['radio','checkbox'].includes(attrs.type)) element.classList.add('pl-ui-input');
    if (element.classList && tag === 'select') element.classList.add('pl-ui-select');
    if (element.classList && tag === 'textarea') element.classList.add('pl-ui-textarea');
    children.flat(Infinity).forEach(child => { if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child))); });
    return element;
  };
  const paths = {forms:'M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h4',home:'M3 11 12 3l9 8 M5 10v11h14V10 M9 21v-8h6v8',plus:'M12 5v14 M5 12h14',chart:'M5 20V10 M12 20V4 M19 20v-7',close:'M6 6l12 12 M18 6 6 18',check:'M5 12l4 4L19 6',arrow:'M5 12h14 M14 7l5 5-5 5'};
  function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('class','icon'); svg.setAttribute('aria-hidden','true'); const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d', paths[name] || paths.forms); svg.append(path); return svg; }
  const button = (label, action, cls = '', glyph, disabled = false) => {
    const variant = cls.includes('primary') ? 'default' : cls.includes('ghost') ? 'ghost' : 'secondary';
    const size = cls.includes('icon-button') ? 'icon' : cls.includes('small') ? 'sm' : 'default';
    const classes = cls.includes('nav-item') ? cls : typeof window !== 'undefined' && window.PLUI?.buttonClasses ? window.PLUI.buttonClasses({variant,size,className:cls}) : `button ${cls}`;
    return node('button',{type:'button',disabled,class:classes,onclick:action},glyph ? icon(glyph) : null,label);
  };
  const uid = () => crypto.randomUUID();
  const definitionId = () => uid().replaceAll('-','');
  const statusLabels = {draft:'Черновик',published:'Открыт',closed:'Завершён'};
  const state = {context:null,surveys:[],view:'available'};
  const dialog = $('#dialog'); let modalTrigger;
  async function api(path, method = 'GET', body, idempotencyKey) {
    const headers = {'Accept':'application/json'};
    if (method !== 'GET') { headers['Content-Type']='application/json'; headers['X-CSRF-Token']=state.context.csrf_token; headers['Idempotency-Key']=idempotencyKey || uid(); }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && new TextEncoder().encode(payload).byteLength > JSON_MAX_BYTES) throw new Error('JSON-запрос превышает 3 МиБ. Уменьшите размер формы.');
    let response;
    try { response = await fetch(`/forms/api/v1${path}`,{method,headers,credentials:'same-origin',body:payload}); }
    catch { throw new Error('Нет связи с сервисом. Проверьте подключение и повторите.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(response.status === 401 ? 'Сессия завершена. Откройте Платформу и войдите снова.' : response.status === 403 ? 'Недостаточно прав для этого действия.' : data.error || 'Не удалось выполнить запрос. Повторите попытку.'); error.status=response.status; throw error; }
    return data;
  }
  function errorBox(error, retry) { return node('div',{class:'notice error',role:'alert'},node('p',{},error.message),retry ? button('Повторить',retry,'small') : null); }
  function openModal(title, wide = false) {
    if (!dialog.open) modalTrigger = document.activeElement; dialog.replaceChildren(); dialog.className = wide ? 'pl-ui-native-dialog wide' : 'pl-ui-native-dialog';
    const close = button('',() => dialog.close(),'ghost icon-button','close'); close.setAttribute('aria-label','Закрыть'); close.title='Закрыть';
    dialog.append(node('div',{class:'dialog-heading'},node('h2',{id:'dialog-title'},title),close));
    if (dialog.open) close.focus(); else dialog.showModal(); return dialog;
  }
  dialog.addEventListener('close',() => { if (modalTrigger?.isConnected) modalTrigger.focus(); });
  async function logout(event) {
    const control = event.currentTarget; control.disabled=true;
    try {
      const sessionResponse = await fetch('/api/v1/session',{credentials:'same-origin',headers:{Accept:'application/json'}});
      if (sessionResponse.status === 401) { location.assign('/'); return; }
      if (!sessionResponse.ok) throw new Error('Не удалось проверить сессию. Повторите выход.');
      const session = await sessionResponse.json();
      const response = await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':session.csrf_token}});
      if (response.ok || response.status === 401) { location.assign('/'); return; }
      throw new Error('Не удалось выйти. Повторите попытку.');
    } catch (error) { const modal = openModal('Выход не выполнен'); modal.append(errorBox(error)); }
    finally { control.disabled=false; }
  }
  function shell() {
    const name = state.context.name || 'Пользователь';
    const available = button(node('span',{class:'nav-label'},'Доступные формы'),() => switchView('available'),'nav-item','forms'); available.id='nav-available'; available.title='Доступные формы'; available.setAttribute('aria-label','Доступные формы');
    const manage = button(node('span',{class:'nav-label'},'Управление'),() => switchView('manage'),'nav-item','chart'); manage.id='nav-manage'; manage.title='Управление'; manage.setAttribute('aria-label','Управление');
    try { if(localStorage.getItem('pl-ui-sidebar-collapsed')===null && localStorage.getItem('pl-forms-sidebar-collapsed')==='true')window.PLUI.sidebar.set(true); } catch {}
    const shared = window.PLUI.createShell({branding:{name:'PL',subtitle:'PLATFORM',label:'Platform'},sidebar:true,navigationId:'forms-navigation',user:{name,subtitle:'Пользователь Платформы'},context:'Формы',onLogout:logout,platformHref:'/'});
    shared.slots.navigation.setAttribute('aria-label','Разделы форм');
    shared.slots.navigation.append(available);
    if (state.context.admin) shared.slots.navigation.append(manage);
    shared.slots.navigation.append(node('div',{class:'divider'}),node('a',{href:'/',class:'nav-item',title:'Платформа','aria-label':'Платформа'},icon('home'),node('span',{class:'nav-label'},'Платформа')));
    shared.slots.sidebarFooter.append(node('span',{class:'pl-ui-sidebar-caption'},'Формы · PL'));
    shared.slots.main.id='main';
    shared.slots.overlays.appendChild(dialog);
    $('#app').append(shared.element);
    $('#app').hidden=false; $('#boot').hidden=true;
  }
  function switchView(view) { state.view=view; render(); }
  function render() {
    $('#nav-available').classList.toggle('active',state.view==='available'); $('#nav-manage')?.classList.toggle('active',state.view==='manage');
    const main = $('#main'); main.replaceChildren();
    const managing = state.view === 'manage';
    main.append(node('div',{class:'page-heading'},node('div',{},node('h1',{},managing ? 'Управление формами' : 'Опросы и тесты'),node('p',{class:'subtitle'},managing ? 'Создавайте формы, открывайте сбор ответов и смотрите результаты.' : 'Поделитесь мнением или пройдите тест.')),managing ? node('div',{class:'page-actions'},button('Импорт JSON',importJSON),button('Создать форму',() => editSurvey(),'primary','plus')) : null));
    const surveys = state.surveys.filter(survey => managing || survey.status === 'published');
    if (!surveys.length) { main.append(node('section',{class:'panel empty'},node('h2',{},managing ? 'Пока нет форм' : 'Сейчас нет открытых форм'),node('p',{},managing ? 'Начните с опроса или теста с результатами по типам.' : 'Новые опросы и тесты появятся здесь, когда их опубликуют.'),managing ? button('Создать форму',() => editSurvey(),'primary','plus') : null)); return; }
    main.append(node('div',{class:'survey-grid'},surveys.map(survey => {
      const actions = node('div',{class:'card-actions'});
      if (!managing) actions.append(button(survey.kind === 'quiz' ? 'Пройти тест' : 'Ответить',() => answerSurvey(survey),'primary','arrow'));
      else {
        if (survey.status === 'draft') actions.append(button('Редактировать',() => loadEditor(survey),'primary'),button('Опубликовать',() => transition(survey,'publish')),button('JSON',() => exportJSON(survey)));
        else {
          actions.append(button('Результаты',() => showResults(survey),'primary','chart'));
          if (survey.status === 'published') actions.append(button('Завершить сбор',() => transition(survey,'close')));
          if (survey.status === 'closed') actions.append(button('Открыть снова',() => transition(survey,'publish')));
        }
      }
      return node('article',{class:'panel survey-card'},node('div',{class:'card-top'},node('span',{class:'kind'},icon('forms'),survey.kind === 'quiz' ? 'Тест' : 'Опрос'),node('span',{class:`badge ${survey.status}`},statusLabels[survey.status] || survey.status)),node('h2',{},survey.title),node('p',{},cleanDescription(survey.description)),node('div',{class:'card-meta'},`${survey.question_count} ${questionWord(survey.question_count)}`),actions);
    })));
  }
  function questionWord(count) { const n = count % 100; return n >= 11 && n <= 14 ? 'вопросов' : count % 10 === 1 ? 'вопрос' : count % 10 >= 2 && count % 10 <= 4 ? 'вопроса' : 'вопросов'; }
  async function refresh() { const data = await api('/surveys'); state.surveys=data.surveys; render(); }
  async function loadEditor(survey) { try { editSurvey(await api(`/surveys/${encodeURIComponent(survey.id)}`)); } catch (error) { openModal('Форма недоступна').append(errorBox(error,() => { dialog.close(); loadEditor(survey); })); } }
  function field(label, value, update, options = {}) {
    const input = node(options.textarea ? 'textarea' : options.select ? 'select' : 'input',{'aria-label':label,required:options.required || false,maxlength:options.max || undefined,type:options.type || (options.textarea || options.select ? undefined : 'text'),min:options.min, max:options.maxNumber,step:options.type === 'number' ? 1 : undefined,oninput:event => update(event.target.value)});
    if (options.select) options.select.forEach(([id,title]) => input.append(node('option',{value:id},title)));
    input.value=value ?? ''; return node('label',{class:'field'},node('span',{},label),input);
  }
  function newQuestion() { return {id:definitionId(),title:'',required:true,options:[{id:definitionId(),label:'',weights:{}},{id:definitionId(),label:'',weights:{}}]}; }
  function editSurvey(existing, imported) {
    const draft = existing || imported ? structuredClone(existing || imported) : {title:'',description:'',kind:'poll',questions:[newQuestion()],outcomes:[]};
    draft.description ??= ''; draft.outcomes ??= []; draft.outcomes.forEach(outcome => { outcome.description ??= ''; });
    const modal = openModal(existing ? 'Редактирование формы' : imported ? 'Импортированная форма' : 'Новая форма',true);
    const form = node('form'); const dynamic = node('div'); const errorArea = node('div');
    let saveKey = uid(); form.addEventListener('input',() => { saveKey=uid(); });
    const kindField = field('Тип формы',draft.kind,value => { draft.kind=value; if (value === 'quiz' && !draft.outcomes.length) draft.outcomes=[{id:definitionId(),title:'',description:''},{id:definitionId(),title:'',description:''}]; draw(); },{select:[['poll','Опрос — собрать мнения'],['quiz','Тест — результат по типам']]} );
    form.append(field('Название',draft.title,value => draft.title=value,{required:true,max:200}),field('Описание',draft.description,value => draft.description=value,{textarea:true,max:4000}),kindField,dynamic,errorArea);
    const save = node('button',{type:'submit',class:'button primary'},'Сохранить черновик');
    form.append(node('div',{class:'dialog-footer'},button('Отмена',() => modal.close()),save));
    function draw() {
      saveKey = uid();
      dynamic.replaceChildren();
      if (draft.kind === 'quiz') {
        const outcomes = node('section',{class:'editor-section'},node('div',{class:'section-heading'},node('h3',{},'Результаты теста'),button('Добавить результат',() => { draft.outcomes.push({id:definitionId(),title:'',description:''}); draw(); },'small','plus',draft.outcomes.length >= 12)),node('p',{class:'hint'},'Для каждого варианта ответа задайте баллы. Участник увидит результат с наибольшей суммой баллов. Если настроен дополнительный вопрос, он разрешит ничью.'));
        draft.outcomes.forEach((outcome,index) => outcomes.append(node('div',{class:'outcome-editor'},node('div',{class:'section-heading'},node('h3',{},`Результат ${index + 1}`),draft.outcomes.length > 2 ? button('Убрать',() => { draft.outcomes.splice(index,1); draft.questions.forEach(q => q.options.forEach(o => delete o.weights[outcome.id])); draw(); },'small ghost') : null),field('Название результата',outcome.title,value => outcome.title=value,{required:true,max:120}),field('Описание результата',outcome.description,value => outcome.description=value,{textarea:true,max:2000}))));
        dynamic.append(outcomes);
        if (draft.scoring) {
          const scoring=node('section',{class:'editor-section'},node('h3',{},'Подсчёт результатов'));
          if (draft.scoring.tie_break) {
            scoring.append(field('Дополнительный вопрос при ничьей',draft.scoring.tie_break.title,value => draft.scoring.tie_break.title=value,{required:true,max:1000}),node('p',{class:'hint'},'Участник увидит только варианты для результатов с одинаковым максимальным баллом. Не указывайте названия результатов в этих вариантах.'));
            draft.outcomes.forEach(outcome => {
              let option=draft.scoring.tie_break.options.find(item => item.outcome_id === outcome.id);
              if (!option) { option={outcome_id:outcome.id,label:''}; draft.scoring.tie_break.options.push(option); }
              scoring.append(field(`Вариант для результата «${outcome.title || 'без названия'}»`,option.label,value => option.label=value,{required:true,max:1000}));
            });
          }
          if (draft.scoring.close_secondary_gap != null) scoring.append(field('Максимальная разница баллов для второго результата',draft.scoring.close_secondary_gap,value => draft.scoring.close_secondary_gap=Number(value),{type:'number',min:0,maxNumber:10,required:true}));
          dynamic.append(scoring);
        }
      }
      const questions = node('section',{class:'editor-section'},node('div',{class:'section-heading'},node('h3',{},'Вопросы'),button('Добавить вопрос',() => { draft.questions.push(newQuestion()); draw(); },'small','plus',draft.questions.length >= 60)));
      draft.questions.forEach((question,index) => {
        const block = node('div',{class:'question-editor'},node('div',{class:'section-heading'},node('h3',{},`Вопрос ${index + 1}`),draft.questions.length > 1 ? button('Убрать вопрос',() => { draft.questions.splice(index,1); draw(); },'small ghost') : null),field('Текст вопроса',question.title,value => question.title=value,{required:true,max:1000}),node('p',{class:'hint'},'Один вариант ответа · обязательный вопрос'));
        if (Object.hasOwn(question,'section')) block.append(field('Раздел',question.section,value => question.section=value,{required:true,max:120}));
        if (Object.hasOwn(question,'help')) block.append(field('Пояснение',question.help,value => question.help=value,{required:true,max:500,textarea:true}));
        if (question.scale) block.append(node('p',{class:'hint'},'Оценочная шкала сохранена из JSON. Её значения можно изменить через импорт JSON.'));
        question.options.forEach((option,optionIndex) => {
          option.weights ||= {};
          const input = node('input',{required:true,maxlength:500,'aria-label':`Вариант ${optionIndex + 1}, вопрос ${index + 1}`,placeholder:`Вариант ${optionIndex + 1}`,oninput:event => option.label=event.target.value}); input.value=option.label;
          block.append(node('div',{class:'option-edit'},input,question.options.length > 2 ? button('Убрать',() => { question.options.splice(optionIndex,1); draw(); },'small ghost') : null));
          if (draft.kind === 'quiz') block.append(node('div',{class:'weights'},draft.outcomes.map((outcome,outcomeIndex) => field(`Баллы: ${outcome.title || `результат ${outcomeIndex + 1}`}`,Object.hasOwn(option.weights,outcome.id) ? option.weights[outcome.id] : 0,value => option.weights[outcome.id]=Number(value),{type:'number',min:-100,maxNumber:100,required:true}))));
        });
        block.append(button('Добавить вариант',() => { question.options.push({id:definitionId(),label:'',weights:{}}); draw(); },'small','plus',question.options.length >= 12)); questions.append(block);
      }); dynamic.append(questions);
    }
    draw();
    form.addEventListener('submit',async event => {
      event.preventDefault(); errorArea.replaceChildren();
      const payload = {title:draft.title.trim(),description:draft.description.trim(),kind:draft.kind,questions:draft.questions.map(q => ({id:q.id,title:q.title.trim(),required:true,options:q.options.map(o => ({id:o.id,label:o.label.trim(),weights:draft.kind === 'quiz' ? Object.fromEntries(draft.outcomes.map(outcome => [outcome.id,Object.hasOwn(o.weights,outcome.id) ? o.weights[outcome.id] : 0])) : {}}))})),outcomes:draft.kind === 'quiz' ? draft.outcomes.map(o => ({id:o.id,title:o.title.trim(),description:o.description.trim()})) : []};
      payload.questions.forEach((question,index) => { for (const key of ['section','help','scale']) if (Object.hasOwn(draft.questions[index],key)) question[key]=structuredClone(draft.questions[index][key]); });
      if (draft.analytics) payload.analytics=structuredClone(draft.analytics);
      if (draft.schema) payload.schema=draft.schema;
      if (draft.presentation) payload.presentation=structuredClone(draft.presentation);
      if (draft.kind === 'quiz' && draft.scoring) { payload.scoring=structuredClone(draft.scoring); if (payload.scoring.tie_break) payload.scoring.tie_break.options=payload.scoring.tie_break.options.filter(option => draft.outcomes.some(outcome => outcome.id === option.outcome_id)); }
      try { validateImport(payload); } catch (error) { errorArea.append(errorBox(error)); return; }
      if (!payload.title || payload.questions.some(q => !q.title || q.options.some(o => !o.label)) || payload.outcomes.some(o => !o.title)) { errorArea.append(errorBox(new Error('Заполните название, вопросы и все варианты ответа.'))); return; }
      save.disabled=true;
      try { await api(existing ? `/surveys/${encodeURIComponent(existing.id)}` : '/surveys',existing ? 'PUT' : 'POST',payload,saveKey); modal.close(); await refresh(); }
      catch (error) { if (modal.open) { errorArea.append(errorBox(error)); errorArea.scrollIntoView({block:'nearest'}); } else showPageError(error); }
      finally { save.disabled=false; }
    });
    modal.append(form);
  }
  function definitionJSON(survey) {
    const result={schema:'pl.forms/v1',title:survey.title,description:survey.description || '',kind:survey.kind,questions:survey.questions,outcomes:survey.outcomes || []};
    if (survey.scoring) result.scoring=survey.scoring;
    if (survey.presentation) result.presentation=survey.presentation;
    if (survey.analytics) result.analytics=survey.analytics;
    return result;
  }
  function downloadJSON(value, filename) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json;charset=utf-8'}));
    const link=node('a',{href:url,download:filename});document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function exportJSON(survey) {
    try { downloadJSON(definitionJSON(await api(`/surveys/${encodeURIComponent(survey.id)}`)),`pl-form-${survey.id}.json`); }
    catch (error) { openModal('Не удалось выгрузить JSON').append(errorBox(error)); }
  }
  function validateImport(raw) {
    const object=(value, allowed, place) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${place}: ожидается объект.`);
      const unknown=Object.keys(value).filter(key => !allowed.includes(key));
      if (unknown.length) throw new Error(`${place}: неизвестные поля — ${unknown.join(', ')}.`);
    };
    const text=(value,max,place,optional=false) => { if (optional && value === undefined) return; if (typeof value !== 'string' || (!optional && !value.trim()) || value.length>max) throw new Error(`${place}: ${optional ? 'текст' : 'непустой текст'} до ${max} символов.`); };
    const list=(value,min,max,place) => { if (!Array.isArray(value) || value.length<min || value.length>max) throw new Error(`${place}: требуется от ${min} до ${max} элементов.`); };
    const ids=new Set();
    const id=(value,place) => { if (typeof value!=='string' || !/^[a-z0-9_]{1,32}$/.test(value)) throw new Error(`${place}: id — от 1 до 32 латинских строчных букв, цифр или _.`); };
    object(raw,['schema','title','description','kind','questions','outcomes','scoring','presentation','analytics'],'Форма');
    if ('schema' in raw && raw.schema!=='pl.forms/v1') throw new Error('Неизвестная schema. Поддерживается pl.forms/v1.');
    text(raw.title,200,'Название');text(raw.description,4000,'Описание',true);
    if (!['poll','quiz'].includes(raw.kind)) throw new Error('kind должен быть poll или quiz.');
    list(raw.outcomes === undefined ? [] : raw.outcomes,raw.kind==='quiz'?2:0,raw.kind==='quiz'?12:0,'Результаты');
    for (const outcome of raw.outcomes || []) {
      object(outcome,['id','title','description'],'Результат');id(outcome.id,'Результат');text(outcome.title,120,'Название результата');text(outcome.description,2000,'Описание результата',true);
      if (ids.has(outcome.id)) throw new Error('Идентификаторы результатов повторяются.');ids.add(outcome.id);
    }
    list(raw.questions,1,60,'Вопросы');const questionIds=new Set();
    raw.questions.forEach((q,index) => {
      const where=`Вопрос ${index+1}`;object(q,['id','title','required','options','section','help','scale'],where);id(q.id,where);text(q.title,1000,where);
      if (questionIds.has(q.id)) throw new Error(`${where}: id повторяется.`);questionIds.add(q.id);
      if ('section' in q) text(q.section,120,`${where}, раздел`);
      if ('help' in q) text(q.help,500,`${where}, пояснение`);
      if ('required' in q && q.required!==true) throw new Error(`${where}: required должен быть true.`);
      list(q.options,2,12,`${where}, варианты`);const optionIds=new Set();const labels=new Set();
      q.options.forEach((o,i) => {
        const label=`${where}, вариант ${i+1}`;object(o,['id','label','weights'],label);id(o.id,label);text(o.label,500,label);
        if (optionIds.has(o.id) || labels.has(o.label.trim())) throw new Error(`${where}: варианты и их id должны различаться.`);optionIds.add(o.id);labels.add(o.label.trim());
        if ('weights' in o) { object(o.weights,[...ids],`${label}, баллы`); if (Object.values(o.weights).some(weight => !Number.isInteger(weight) || weight < -100 || weight > 100)) throw new Error(`${label}: баллы — целые числа от −100 до 100.`); }
      });
      if ('scale' in q) {
        object(q.scale,[...optionIds],`${where}, шкала`);
        if (Object.keys(q.scale).length<2 || Object.values(q.scale).some(value => !Number.isInteger(value) || value<1 || value>5)) throw new Error(`${where}: шкала должна содержать минимум два варианта с целыми оценками от 1 до 5.`);
      }
    });
    if ('analytics' in raw) {
      if (raw.kind!=='poll') throw new Error('analytics доступна только для опросов.');
      const a=raw.analytics;const keys=['role_question_id','manager_option_id','employee_option_id','filter_question_ids','metrics'];
      object(a,keys,'Аналитика');
      if (keys.some(key => !Object.hasOwn(a,key))) throw new Error('analytics: заполните роль, варианты групп, фильтры и показатели.');
      const role=raw.questions.find(q => q.id===a.role_question_id);
      if (!role || !role.options.some(o => o.id===a.manager_option_id) || !role.options.some(o => o.id===a.employee_option_id) || a.manager_option_id===a.employee_option_id) throw new Error('analytics: укажите вопрос о роли и два разных существующих варианта для руководителей и сотрудников.');
      list(a.filter_question_ids,1,12,'Фильтры');
      if (new Set(a.filter_question_ids).size!==a.filter_question_ids.length || a.filter_question_ids.some(value => !questionIds.has(value)) || !a.filter_question_ids.includes(a.role_question_id)) throw new Error('analytics: фильтры должны ссылаться на разные вопросы, включая вопрос о роли.');
      list(a.metrics,1,12,'Показатели');const metricIds=new Set();
      a.metrics.forEach(metric => {
        object(metric,['id','title','question_ids'],'Показатель');id(metric.id,'Показатель');text(metric.title,120,'Название показателя');
        if (metricIds.has(metric.id)) throw new Error('Идентификаторы показателей повторяются.');metricIds.add(metric.id);
        list(metric.question_ids,1,60,'Вопросы показателя');
        if (new Set(metric.question_ids).size!==metric.question_ids.length || metric.question_ids.some(value => !raw.questions.some(q => q.id===value && q.scale))) throw new Error('Показатель должен ссылаться на разные вопросы с оценочной шкалой.');
      });
    }
    if ('scoring' in raw) {
      if (raw.kind!=='quiz') throw new Error('scoring доступен только для тестов.');
      object(raw.scoring,['tie_break','close_secondary_gap'],'Подсчёт результатов');
      if (!raw.scoring.tie_break) throw new Error('scoring: укажите tie_break с дополнительным вопросом.');
      if (raw.scoring.close_secondary_gap != null && (!Number.isInteger(raw.scoring.close_secondary_gap) || raw.scoring.close_secondary_gap<0 || raw.scoring.close_secondary_gap>10)) throw new Error('close_secondary_gap — целое число от 0 до 10.');
      if (raw.scoring.tie_break != null) {
        const tie=raw.scoring.tie_break;object(tie,['title','options'],'Дополнительный вопрос');text(tie.title,1000,'Дополнительный вопрос');list(tie.options,2,12,'Варианты дополнительного вопроса');const tieIds=new Set();
        tie.options.forEach(option => { object(option,['outcome_id','label'],'Вариант дополнительного вопроса');if (!ids.has(option.outcome_id) || tieIds.has(option.outcome_id)) throw new Error('Дополнительный вопрос: каждый outcome_id должен соответствовать одному результату.');tieIds.add(option.outcome_id);text(option.label,1000,'Вариант дополнительного вопроса'); });
        if (tieIds.size!==ids.size) throw new Error('Дополнительный вопрос: нужен вариант для каждого результата.');
      }
    }
    if ('presentation' in raw) {
      object(raw.presentation,['question_order','shuffle_options','shuffle_tie_options','allow_back'],'Показ вопросов');
      const p=raw.presentation;
      if (p.question_order!=='fixed' || !['once_per_attempt','none'].includes(p.shuffle_options) || p.shuffle_tie_options!=='once_when_tie_question_appears' || p.allow_back!==true) throw new Error('presentation: порядок вопросов — fixed, варианты — none или once_per_attempt, возврат — allow_back: true; shuffle_tie_options — once_when_tie_question_appears.');
    }
    return raw;
  }
  function convertSource(source) {
    const known=(value,keys,label) => {
      if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
      const extra=Object.keys(value).filter(key => !keys.includes(key));
      if (extra.length) throw new Error(`${label}: неизвестные поля — ${extra.join(', ')}.`);
    };
    const string=(value,label) => { if (typeof value!=='string') throw new Error(`${label}: ожидается текст.`);return value; };
    const array=(value,label) => { if (!Array.isArray(value)) throw new Error(`${label}: ожидается список.`);return value; };
    known(source,['schema_version','content_version','quiz_id','language','title','kind','estimated_minutes','intro','scoring','presentation','ui','characters','questions','tie_break','flow','editorial_notes'],'Исходная анкета');
    if (source.schema_version!=='1.0' || source.kind!=='entertainment_personality') throw new Error('Поддерживается исходный формат entertainment_personality версии 1.0.');
    known(source.intro,['lead','instruction','note','start_button'],'Вступление');
    known(source.scoring,['method','primary_weight','secondary_weight','max_per_character','total_awarded_points','secondary_max_gap','secondary_max_gap_is','partial_result','tie_break_adds_points','display_confidence_percent','equal_maxima_explanation'],'Подсчёт исходной анкеты');
    if (source.scoring.method!=='weighted_character_sum' || source.scoring.partial_result!==false || source.scoring.tie_break_adds_points!==false || source.scoring.display_confidence_percent!==false) throw new Error('Исходная анкета задаёт неподдерживаемый способ подсчёта.');
    known(source.presentation,['question_order','shuffle_options','shuffle_tie_options','option_identity','allow_back','all_questions_required','show_weights','show_characters_before_result','show_partial_scores','minimum_questions','maximum_questions','save_attempt_version','changing_main_answer_invalidates_tie_choice'],'Показ исходной анкеты');
    if (source.presentation.all_questions_required!==true || source.presentation.show_weights!==false || source.presentation.show_characters_before_result!==false || source.presentation.show_partial_scores!==false || source.presentation.option_identity!=='id') throw new Error('Исходная анкета задаёт неподдерживаемый показ ответов.');
    if (source.ui) known(source.ui,['next','previous','finish','restart','share','answer_required','progress','tie_progress','result_heading','secondary_heading','tie_note','result_footer'],'Подписи исходной анкеты');
    if (source.flow) known(source.flow,['start','main','incomplete','unique_leader','multiple_second_places','exact_tie','two_way_tie','three_or_more_way_tie','edit','restart'],'Сценарий исходной анкеты');
    if (source.editorial_notes) known(source.editorial_notes,['character_scope','weight_meaning','interpretation','platform_import','output_policy'],'Примечания исходной анкеты');
    known(source.tie_break,['id','text','filter','selection','score_effect','options'],'Дополнительный вопрос исходной анкеты');
    if (source.tie_break.filter!=='only_characters_with_exact_maximum_score' || source.tie_break.selection!=='one_required_option' || source.tie_break.score_effect!=='none') throw new Error('Исходная анкета задаёт неподдерживаемое разрешение ничьей.');
    const outcomes=array(source.characters,'Персонажи').map(character => {
      known(character,['id','name','headline','description','strength','blind_spot','tip','share_text','name_genitive'],'Персонаж');
      return {id:character.id,title:`${string(character.name,'Имя')} — ${string(character.headline,'Заголовок')}`,description:`${string(character.description,'Описание')}\n\nСильная сторона: ${string(character.strength,'Сильная сторона')}\n\nОбратная сторона: ${string(character.blind_spot,'Обратная сторона')}\n\nПодсказка: ${string(character.tip,'Подсказка')}`};
    });
    const questions=array(source.questions,'Вопросы').map(question => {
      known(question,['id','text','options'],'Исходный вопрос');
      return {id:question.id,title:question.text,required:true,options:array(question.options,'Варианты').map(option => { known(option,['id','text','weights'],'Исходный вариант');return {id:option.id,label:option.text,weights:option.weights}; })};
    });
    const tieOptions=array(source.tie_break.options,'Уточняющие варианты').map(option => { known(option,['id','character_id','text'],'Уточняющий вариант');return {outcome_id:option.character_id,label:option.text}; });
    const p=source.presentation;
    return {schema:'pl.forms/v1',title:source.title,description:[source.intro.lead,source.intro.instruction,source.intro.note].map(value => string(value,'Вступление')).filter(value => value!==removedNote).join('\n\n'),kind:'quiz',questions,outcomes,scoring:{tie_break:{title:source.tie_break.text,options:tieOptions},close_secondary_gap:source.scoring.secondary_max_gap},presentation:{question_order:p.question_order,shuffle_options:p.shuffle_options,shuffle_tie_options:p.shuffle_tie_options,allow_back:p.allow_back}};
  }
  function importJSON() {
    const modal=openModal('Импорт JSON',true);
    const source=node('textarea',{'aria-label':'JSON формы',class:'json-input',spellcheck:false,placeholder:'{ "schema": "pl.forms/v1", "title": "Название формы", … }'});
    const errors=node('div');const preview=node('div');let parsed=null;let key=uid();
    const open=button('Открыть в редакторе',() => { if (parsed) editSurvey(null,parsed); },'',null,true);
    const save=button('Сохранить черновик',async () => {
      if (!parsed) return;save.disabled=true;open.disabled=true;errors.replaceChildren();
      try { await api('/surveys','POST',parsed,key);modal.close();await refresh(); }
      catch (error) { if (modal.open) errors.append(errorBox(error)); else showPageError(error); }
      finally { save.disabled=!parsed;open.disabled=!parsed; }
    },'primary',null,true);
    const invalidate=() => { parsed=null;key=uid();preview.replaceChildren();errors.replaceChildren();open.disabled=true;save.disabled=true; };
    source.addEventListener('input',invalidate);
    function parse() {
      invalidate();
      try {
        if (new TextEncoder().encode(source.value).byteLength>JSON_MAX_BYTES) throw new Error('JSON превышает 3 МиБ. Уменьшите размер файла.');
        let value;try { value=JSON.parse(source.value); } catch { throw new Error('Некорректный JSON. Проверьте кавычки, запятые и скобки.'); }
        const converted=value && typeof value==='object' && 'schema_version' in value;
        parsed=validateImport(converted ? convertSource(value) : value);
        const count=parsed.questions.reduce((total,q) => total+q.options.length,0);
        preview.append(node('section',{class:'notice import-preview'},node('h3',{},parsed.title),node('p',{},`${parsed.kind==='quiz'?'Тест':'Опрос'} · ${parsed.questions.length} ${questionWord(parsed.questions.length)} · вариантов: ${count} · результатов: ${parsed.outcomes?.length || 0}`),parsed.scoring?.tie_break ? node('p',{},'Дополнительный вопрос при ничьей настроен.') : null,converted ? node('p',{},'Исходный формат 1.0 преобразован в формат Платформы. Вопросы, баллы, описания и порядок прохождения сохранены.') : null));
        open.disabled=false;save.disabled=false;
      } catch (error) { errors.append(errorBox(error)); }
    }
    const file=node('input',{type:'file',accept:'.json,application/json','aria-label':'JSON-файл',onchange:async event => {
      invalidate();const selected=event.target.files[0];if (!selected) return;
      if (selected.size>JSON_MAX_BYTES) { errors.append(errorBox(new Error('Файл превышает 3 МиБ. Выберите файл меньшего размера.')));return; }
      try {
        const text=await selected.text();let start=0,end=text.length;
        // Do not lay out millions of empty lines for padding around a JSON file.
        // Keep JSON's exact whitespace set; NBSP is invalid and must stay invalid.
        while(start<end && ' \t\r\n'.includes(text[start])) start++;
        while(end>start && ' \t\r\n'.includes(text[end-1])) end--;
        source.value=text.slice(start,end);parse();
      } catch { errors.append(errorBox(new Error('Не удалось прочитать файл. Выберите его повторно.'))); }
    }});
    const example=() => downloadJSON({schema:'pl.forms/v1',title:'Как вы решаете задачи?',description:'Выберите подходящий вариант.',kind:'quiz',outcomes:[{id:'planner',title:'Планировщик',description:'Вы продумываете шаги заранее.'},{id:'explorer',title:'Исследователь',description:'Вы пробуете решения на практике.'}],questions:[{id:'start',title:'Ваш первый шаг в новой задаче?',required:true,options:[{id:'plan',label:'Составлю план',weights:{planner:2}},{id:'try',label:'Проведу эксперимент',weights:{explorer:2}}]}]},'pl-forms-example.json');
    modal.append(node('p',{class:'dialog-description'},'Выберите локальный JSON-файл или вставьте текст. Максимум 3 МиБ. После проверки можно открыть форму в редакторе или сразу сохранить черновик.'),node('label',{class:'field'},node('span',{},'JSON-файл'),file),node('label',{class:'field'},node('span',{},'JSON формы'),source),node('div',{class:'page-actions'},button('Проверить JSON',parse),button('Скачать пример',example,'ghost')),errors,preview,node('div',{class:'dialog-footer'},button('Отмена',() => modal.close()),open,save));
  }
  function showPageError(error) { $('#main').prepend(errorBox(error,() => refresh().catch(showPageError))); }
  function transition(survey,action) {
    const publishing = action === 'publish'; const reopening = publishing && survey.status === 'closed';
    const modal = openModal(reopening ? 'Открыть сбор ответов снова?' : publishing ? 'Опубликовать форму?' : 'Завершить сбор ответов?');
    modal.append(node('p',{class:'dialog-description'},reopening ? `«${survey.title}» снова станет доступна сотрудникам. Вопросы и ранее собранные ответы сохранятся.` : publishing ? `«${survey.title}» станет доступна сотрудникам. После публикации изменить вопросы и варианты ответа нельзя.` : `«${survey.title}» больше не будет принимать ответы. Собранные результаты сохранятся.`));
    const errors = node('div'); const key=uid();
    const confirm = button(reopening ? 'Открыть снова' : publishing ? 'Опубликовать' : 'Завершить сбор',async () => {
      confirm.disabled=true; errors.replaceChildren();
      try { await api(`/surveys/${encodeURIComponent(survey.id)}/${action}`,'POST',{},key); modal.close(); await refresh(); }
      catch (error) { if (modal.open) errors.append(errorBox(error)); else showPageError(error); }
      finally { confirm.disabled=false; }
    },'primary');
    modal.append(errors,node('div',{class:'dialog-footer'},button('Отмена',() => modal.close()),confirm));
  }
  async function answerSurvey(summary) {
    let survey; try { survey = await api(`/surveys/${encodeURIComponent(summary.id)}`); } catch (error) { openModal('Форма недоступна').append(errorBox(error)); return; }
    const stepped=!!survey.presentation;
    const storageKey = `pl-forms-pending:${survey.id}:${survey.version}`;
    const attemptKey = `pl-forms-attempt:${survey.id}:${survey.version}`;
    const shuffle=items => { const result=[...items];for(let i=result.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]]; }return result; };
    let pending = null;let attempt=null;
    const validTie=tie => tie && typeof tie.title==='string' && Array.isArray(tie.options) && tie.options.length>=2 && tie.options.every(option => typeof option.id==='string' && typeof option.label==='string');
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved.submissionId === 'string' && saved.answers && Object.keys(saved.answers).length === survey.questions.length && survey.questions.every(q => q.options.some(o => o.id === saved.answers[q.id]))) {
        pending=saved;pending.stage ||= 'unknown';pending.requestKey ||= pending.submissionId;
        if (pending.stage==='tie' && !validTie(pending.tieOptions)) pending.stage='unknown';
      }
      if (stepped) {
        const savedAttempt=JSON.parse(sessionStorage.getItem(attemptKey) || 'null');
        if (savedAttempt && Number.isInteger(savedAttempt.index) && savedAttempt.index>=0 && savedAttempt.index<survey.questions.length && savedAttempt.answers && savedAttempt.optionOrder && survey.questions.every(q => Array.isArray(savedAttempt.optionOrder[q.id]) && savedAttempt.optionOrder[q.id].length===q.options.length && new Set(savedAttempt.optionOrder[q.id]).size===q.options.length && savedAttempt.optionOrder[q.id].every(id => q.options.some(o => o.id===id)))) attempt=savedAttempt;
      }
    } catch {}
    if (stepped && !attempt) attempt={index:0,answers:{},optionOrder:Object.fromEntries(survey.questions.map(q => [q.id,survey.presentation.shuffle_options==='none' ? q.options.map(o => o.id) : shuffle(q.options.map(o => o.id))]))};
    if (pending && attempt) { attempt.answers={...pending.answers};attempt.index=survey.questions.length-1; }
    const modal = openModal(survey.title); const form=node('form',{novalidate:stepped});
    const description=node('p',{class:'dialog-description'},cleanDescription(survey.description));
    form.append(description);
    const pendingNotice=node('div',{class:'notice',hidden:!pending});
    const progressText=node('span');const progress=node('progress',{max:survey.questions.length,value:1,'aria-label':'Прогресс прохождения'});
    const progressArea=node('div',{class:'quiz-progress',hidden:!stepped},progressText,progress);form.append(pendingNotice,progressArea);
    const questions=node('div');const errors=node('div');const fieldsets=[];
    function saveAttempt() {
      if (!attempt) return;
      try { sessionStorage.setItem(attemptKey,JSON.stringify(attempt)); }
      catch { throw new Error('Браузер не разрешает временно сохранить попытку в этой вкладке. Разрешите хранение данных для сайта.'); }
    }
    survey.questions.forEach((question,index) => {
      const options=attempt ? attempt.optionOrder[question.id].map(id => question.options.find(option => option.id===id)) : question.options;
      const fieldset=node('fieldset',{class:stepped ? 'question step-question' : 'question'},node('legend',{tabindex:-1},stepped ? question.title : `${index + 1}. ${question.title}`),options.map(option => node('label',{class:'answer-option'},node('input',{type:'radio',name:question.id,value:option.id,required:true,checked:(pending?.answers || attempt?.answers)?.[question.id] === option.id,disabled:!!pending,onchange:() => {
        if (!attempt) return;attempt.answers[question.id]=option.id;delete attempt.tieOrder;
        try { saveAttempt(); } catch (error) { errors.replaceChildren(errorBox(error)); }
      }}),node('span',{},option.label))));
      if (question.section) fieldset.querySelector('legend').prepend(node('span',{class:'question-section'},question.section));
      if (question.help) fieldset.insertBefore(node('p',{class:'question-help'},question.help),fieldset.querySelector('.answer-option'));
      fieldsets.push(fieldset);questions.append(fieldset);
    });
    const tieArea=node('div');form.append(questions,tieArea);
    const submit = node('button',{type:'submit',class:'button primary'},'Отправить ответы');
    const previous=button('Назад',() => {
      errors.replaceChildren();
      if (pending?.stage==='tie') {
        if (attempt) { attempt.submissionId=pending.submissionId;attempt.index=survey.questions.length-1; }
        clearPending();
      } else if (attempt && attempt.index>0) attempt.index--;
      try { saveAttempt(); } catch (error) { errors.append(errorBox(error)); }
      drawStage();focusCurrent();
    });
    const next=button('Дальше',() => {
      errors.replaceChildren();const question=survey.questions[attempt.index];
      if (!question.options.some(option => option.id===attempt.answers[question.id])) { errors.append(errorBox(new Error('Выберите один вариант, который вам ближе.')));questions.querySelector('fieldset:not([hidden]) input')?.focus();return; }
      attempt.index++;try { saveAttempt(); } catch (error) { errors.append(errorBox(error)); }drawStage();focusCurrent();
    },'primary','arrow');
    form.append(errors,node('div',{class:'dialog-footer'},previous,button('Отмена',() => modal.close()),next,submit));
    function focusCurrent() { fieldsets[attempt?.index || 0].querySelector('legend')?.focus();modal.scrollTop=0; }
    function savePending() {
      try { sessionStorage.setItem(storageKey,JSON.stringify(pending)); }
      catch { throw new Error('Браузер не разрешает временно сохранить отправку в этой вкладке. Разрешите хранение данных для сайта и повторите.'); }
    }
    function drawStage() {
      const waiting=!!pending && pending.stage!=='tie';const tieVisible=validTie(pending?.tieOptions);
      questions.querySelectorAll('input').forEach(input => input.disabled=!!pending);
      fieldsets.forEach((fieldset,index) => { fieldset.hidden=stepped && (tieVisible || index!==attempt.index); });
      description.hidden=stepped && (attempt.index>0 || tieVisible);
      pendingNotice.hidden=!pending;
      pendingNotice.textContent=waiting ? 'Предыдущая отправка не подтверждена. Ответы временно сохранены в этой вкладке. Повторите отправку, чтобы получить подтверждение; до этого изменить ответы нельзя.' : 'Чтобы определить результат, ответьте ещё на один вопрос. Основные ответы уже выбраны.';
      submit.textContent=waiting ? 'Повторить отправку' : pending?.stage==='tie' ? 'Показать результат' : stepped && survey.kind==='quiz' ? 'Узнать результат' : 'Отправить ответы';
      submit.hidden=stepped && !pending && attempt.index<survey.questions.length-1;
      previous.hidden=!stepped || !survey.presentation.allow_back || waiting || (!pending && attempt.index===0);
      next.hidden=!stepped || !!pending || attempt.index>=survey.questions.length-1;
      if (stepped) { progressText.textContent=tieVisible ? 'Последний штрих' : `Вопрос ${attempt.index+1} из ${survey.questions.length}`;progress.max=survey.questions.length+(tieVisible?1:0);progress.value=tieVisible ? progress.max : attempt.index+1; }
      tieArea.replaceChildren();
      if (tieVisible) tieArea.append(node('fieldset',{class:'question tie-question'},node('legend',{tabindex:-1},pending.tieOptions.title),pending.tieOptions.options.map(option => node('label',{class:'answer-option'},node('input',{type:'radio',name:'__tie_break',value:option.id,required:true,disabled:waiting,checked:pending.tieBreak===option.id}),node('span',{},option.label)))));
    }
    function clearPending() { pending=null; try { sessionStorage.removeItem(storageKey); } catch {} }
    drawStage();try { saveAttempt(); } catch (error) { errors.append(errorBox(error)); }
    form.addEventListener('submit',async event => {
      event.preventDefault(); errors.replaceChildren();submit.disabled=true;let requestStarted=false;const hadPending=!!pending;
      try {
        if (!pending) {
          const answers=attempt ? {...attempt.answers} : Object.fromEntries(new FormData(form));
          const missing=survey.questions.findIndex(q => !q.options.some(option => option.id===answers[q.id]));
          if (missing!==-1) { if (attempt) {attempt.index=missing;drawStage();focusCurrent();}throw new Error('Ответьте на все вопросы перед отправкой.'); }
          pending={submissionId:attempt?.submissionId || uid(),requestKey:uid(),answers,stage:'unknown'};
        } else if (pending.stage==='tie') {
          const selected=new FormData(form).get('__tie_break');
          if (!pending.tieOptions.options.some(option => option.id===selected)) throw new Error('Выберите один вариант дополнительного вопроса.');
          pending.tieBreak=selected;pending.stage='unknown';pending.requestKey=uid();
        }
        savePending();drawStage();requestStarted=true;
        const payload={version:survey.version,answers:pending.answers,submission_id:pending.submissionId};
        if (pending.tieBreak) payload.tie_break=pending.tieBreak;
        const result = await api(`/surveys/${encodeURIComponent(survey.id)}/responses`,'POST',payload,pending.requestKey);
        if (!result.saved && validTie(result.tie_break)) {
          let tie=result.tie_break;
          if (attempt) {
            const ids=tie.options.map(option => option.id);
            if (!attempt.tieOrder || attempt.tieOrder.length!==ids.length || !attempt.tieOrder.every(id => ids.includes(id))) attempt.tieOrder=shuffle(ids);
            tie={title:tie.title,options:attempt.tieOrder.map(id => tie.options.find(option => option.id===id))};saveAttempt();
          }
          pending.tieOptions=tie;pending.stage='tie';delete pending.tieBreak;savePending();drawStage();tieArea.scrollIntoView({block:'nearest'});tieArea.querySelector('legend')?.focus();return;
        }
        if (!result.saved) throw new Error('Сервис не подтвердил сохранение. Повторите отправку.');
        clearPending();try { sessionStorage.removeItem(attemptKey); } catch {}
        const secondary=result.outcome?.secondary;
        form.replaceChildren(node('div',{class:'success-mark'},icon('check')),node('h2',{},result.outcome ? result.outcome.title : 'Спасибо за ответ'),node('p',{class:'dialog-description'},result.outcome ? result.outcome.description : 'Ваши ответы сохранены.'),secondary ? node('section',{class:'secondary-result'},node('span',{class:'hint'},'Также вам близок этот результат'),node('h3',{},secondary.title),node('p',{class:'dialog-description'},secondary.description)) : null,node('div',{class:'dialog-footer'},stepped && survey.kind==='quiz' ? button('Пройти ещё раз',() => answerSurvey(summary)) : null,button('Готово',() => modal.close(),'primary')));
      } catch (error) {
        if ((error.status >= 400 && error.status < 500 && error.status !== 408) || (!requestStarted && !hadPending && pending?.stage==='unknown')) { clearPending();drawStage(); }
        errors.append(errorBox(error)); errors.scrollIntoView({block:'nearest'});
      } finally { submit.disabled=false; }
    }); modal.append(form);
  }
  const resultNumber = value => typeof value==='number' && Number.isFinite(value) ? new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value) : '—';
  function resultSelection(results) {
    return (results.filter_definitions || []).flatMap(filter => {
      const ids=results.filters?.[filter.id] || [];
      return ids.length ? [{question_id:filter.id,title:filter.title,options:filter.options.filter(option => ids.includes(option.id)).map(option => ({id:option.id,label:option.label}))}] : [];
    });
  }
  function aggregateExport(survey,results) {
    const metric=value => Object.fromEntries(['id','title','score','favorable_percent','negative_percent','valid_answers','respondents','favorable_answers','negative_answers'].filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));
    return {schema:'pl.forms.results/v1',title:survey.title,kind:survey.kind,exported_at:new Date().toISOString(),total:results.total,overall_total:results.overall_total ?? results.total,pending:results.pending || 0,filters:structuredClone(results.filters || {}),selection:resultSelection(results),metrics:(results.metrics || []).map(metric),comparison:(results.comparison || []).map(group => ({id:group.id,title:group.title,total:group.total,metrics:(group.metrics || []).map(metric)})),questions:results.questions.map(question => ({id:question.id,title:question.title,...(question.section ? {section:question.section} : {}),options:question.options.map(option => ({id:option.id,label:option.label,count:option.count})),...(question.scale_summary ? {scale_summary:metric(question.scale_summary)} : {})})),outcomes:(results.outcomes || []).map(outcome => ({id:outcome.id,title:outcome.title,count:outcome.count}))};
  }
  function exportResults(survey,results,format) {
    const data=aggregateExport(survey,results);const filename=`pl-results-${String(survey.id).replace(/[^a-z0-9_-]/gi,'').slice(0,64)}-${new Date().toISOString().slice(0,10)}`;
    if (format==='json') { downloadJSON(data,`${filename}.json`);return; }
    const filters=data.selection.map(filter => `${filter.title}: ${filter.options.map(option => option.label).join(' / ')}`).join('; ') || 'Все ответы';
    const rows=[['Тип строки','Выборка','Группа','Раздел','Вопрос / показатель','Вариант','Число ответов','Всего в группе','Индекс 0–100','Доля положительных, %','Доля отрицательных, %','Положительных ответов','Отрицательных ответов','Оценочных ответов','Анкет в показателе'],['Сводка',filters,'Все ответы','','','',data.total,data.overall_total],['Ожидают обработки во всей форме',filters,'Все ответы','','','',data.pending]];
    const addMetric=(value,group,total,section='',kind='Показатель') => rows.push([kind,filters,group,section,value.title || '', '', '',total,value.score,value.favorable_percent,value.negative_percent,value.favorable_answers,value.negative_answers,value.valid_answers,value.respondents]);
    data.comparison.forEach(group => rows.push(['Группа',filters,group.title,'','','',group.total,data.total]));
    if (data.comparison.length) rows.push(['Группа',filters,'Роль не указана','','','',Math.max(0,data.total-data.comparison.reduce((sum,group) => sum+group.total,0)),data.total]);
    data.metrics.forEach(value => addMetric(value,'Все ответы',data.total));
    data.comparison.forEach(group => group.metrics.forEach(value => addMetric(value,group.title,group.total)));
    data.questions.forEach(question => {
      question.options.forEach(option => rows.push(['Распределение',filters,'Все ответы',question.section || '',question.title,option.label,option.count,data.total]));
      if (question.scale_summary) addMetric({...question.scale_summary,title:question.title},'Все ответы',data.total,question.section || '','Оценка вопроса');
    });
    data.outcomes.forEach(outcome => rows.push(['Результат теста',filters,'Все ответы','','',outcome.title,outcome.count,data.total]));
    const cell=value => { let text=value == null ? '' : String(value);if (typeof value==='string' && (/^[\t\r]/.test(text) || /^\s*[=+@-]/.test(text))) text=`'${text}`;return `"${text.replaceAll('"','""')}"`; };
    const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row => Array.from({length:rows[0].length},(_,index) => cell(row[index])).join(';')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
    const link=node('a',{href:url,download:`${filename}.csv`});document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function showResults(survey) {
    const modal = openModal('Результаты формы',true);modal.classList.add('results-dialog');
    const body=node('div',{class:'results-body'},node('p',{class:'hint',role:'status'},'Загружаем результаты…'));modal.append(body);
    const alive=() => modal.open && body.isConnected && modal.contains(body);
    let applied=null;let request=0;let busy=false;
    const errors=node('div');const content=node('div',{'aria-live':'polite'});const filterArea=node('div');const controls=new Map();const appliedLabel=node('p',{class:'hint result-selection'});
    const csv=button('Скачать CSV',() => { if (applied) exportResults(survey,applied,'csv'); });
    const json=button('Скачать JSON',() => { if (applied) exportResults(survey,applied,'json'); });
    const apply=button('Применить выборку',() => load(readFilters()),'primary');
    const reset=button('Сбросить',() => load({}));
    function readFilters() { return Object.fromEntries([...controls].map(([id,values]) => [id,values.filter(input => input.checked).map(input => input.value)]).filter(([,ids]) => ids.length)); }
    function setBusy(value) {
      busy=value;body.setAttribute('aria-busy',String(value));[apply,reset,csv,json,...[...controls.values()].flat()].forEach(control => control.disabled=value);
      apply.textContent=value ? 'Обновляем…' : 'Применить выборку';
    }
    function buildFilters(results) {
      if (!results.filter_definitions?.length) return;
      const grid=node('div',{class:'result-filter-grid'});
      results.filter_definitions.forEach(filter => {
        const title=node('summary',{},filter.title,node('span',{class:'filter-count'},'Все'));
        const options=node('div',{class:'result-filter-options'});const values=[];
        filter.options.forEach(option => {
          const input=node('input',{type:'checkbox',value:option.id,'aria-label':`${filter.title}: ${option.label}`,onchange:() => { const count=values.filter(item => item.checked).length;title.querySelector('.filter-count').textContent=count ? `Выбрано: ${count}` : 'Все'; }});
          values.push(input);options.append(node('label',{},input,node('span',{},option.label)));
        });
        controls.set(filter.id,values);grid.append(node('details',{class:'result-filter'},title,options));
      });
      filterArea.append(node('details',{class:'result-filters'},node('summary',{},'Выборка ответов'),node('p',{class:'hint'},'Можно выбрать несколько вариантов в каждом поле. Между полями действует условие «и». Неотмеченное поле включает все варианты.'),grid,node('div',{class:'page-actions'},apply,reset)));
    }
    function syncFilters(results) {
      for (const [id,inputs] of controls) {
        const selected=results.filters?.[id] || [];
        inputs.forEach(input => input.checked=selected.includes(input.value));
        const summary=inputs[0]?.closest('details').querySelector('.filter-count');if (summary) summary.textContent=selected.length ? `Выбрано: ${selected.length}` : 'Все';
      }
    }
    function metricCell(metric) {
      if (!metric || metric.score==null) return node('td',{},node('span',{class:'metric-score'},'—'),node('span',{class:'metric-detail'},'Нет оценочных ответов'));
      return node('td',{},node('span',{class:'metric-score'},resultNumber(metric.score)),node('span',{class:'metric-detail'},`Положительные: ${resultNumber(metric.favorable_percent)}% · отрицательные: ${resultNumber(metric.negative_percent)}%`),node('span',{class:'metric-detail'},`Оценок: ${metric.valid_answers} · анкет: ${metric.respondents}`));
    }
    function renderResults(results) {
      content.replaceChildren();const selection=resultSelection(results);
      appliedLabel.textContent=selection.length ? 'Применено: '+selection.map(filter => `${filter.title}: ${filter.options.map(option => option.label).join(', ')}`).join(' · ') : 'Применено: все ответы';
      const total=node('div',{class:'result-summary'},node('div',{},node('div',{class:'result-total'},results.total),node('p',{class:'hint'},selection.length ? `Ответов в выборке из ${results.overall_total ?? results.total}` : 'Всего ответов')));
      if (results.comparison?.length) total.append(node('div',{class:'result-group-totals'},results.comparison.map(group => node('div',{},node('strong',{},group.total),node('span',{},group.title)))));
      if (results.comparison?.length) {
        const unspecified=Math.max(0,results.total-results.comparison.reduce((sum,group) => sum+group.total,0));
        total.querySelector('.result-group-totals').append(node('div',{},node('strong',{},unspecified),node('span',{},'Роль не указана')));
      }
      content.append(total);
      if (results.pending) content.append(node('div',{class:'notice'},`Ожидают обработки во всей форме: ${results.pending}. Эти отправки пока не включены в результаты.`));
      if (!results.total) content.append(node('div',{class:'notice'},selection.length ? 'В этой выборке ответов нет. Измените фильтры или сбросьте выборку.' : 'Ответов пока нет. Результаты появятся после первой отправки.'));
      if (results.metrics?.length) {
        const groups=[{title:'Все ответы',total:results.total,metrics:results.metrics},...(results.comparison || [])];
        const head=node('thead',{},node('tr',{},node('th',{scope:'col'},'Показатель'),groups.map(group => node('th',{scope:'col'},group.title,node('span',{class:'metric-detail'},`Анкет: ${group.total}`)))));
        const rows=results.metrics.map(metric => node('tr',{},node('th',{scope:'row'},metric.title),groups.map(group => metricCell(group.metrics.find(value => value.id===metric.id)))));
        const table=node('table',{class:'result-metrics'},node('caption',{},'Показатели и сравнение групп'),head,node('tbody',{},rows));
        content.append(node('div',{class:'result-table-scroll',tabindex:0,'aria-label':'Показатели и сравнение групп'},table),node('p',{class:'hint result-method'},'Индекс: среднее оценок каждой анкеты по вопросам показателя, приведённое со шкалы 1–5 к 0–100. Положительные ответы — 4–5, отрицательные — 1–2. Варианты вне шкалы не входят в оценку. Число оценок может отличаться от числа анкет.'));
      }
      function distribution(title,options,scale) {
        return node('section',{class:'result-block'},node('h3',{},title),scale ? node('p',{class:'hint'},`Индекс: ${resultNumber(scale.score)} из 100 · оценочных ответов: ${scale.valid_answers}`) : null,options.map(option => {
          const percent=results.total ? option.count/results.total*100 : null;const fill=node('div',{class:'bar-fill'});fill.style.width=`${Math.max(0,Math.min(100,percent || 0))}%`;
          return node('div',{class:'result-row'},node('div',{class:'result-label'},node('span',{},option.label || option.title),node('span',{},`${option.count} · ${resultNumber(percent)}${percent==null ? '' : '%'}`)),node('div',{class:'bar','aria-hidden':'true'},fill));
        }));
      }
      if (results.outcomes?.length) content.append(distribution('Результаты теста',results.outcomes));
      const sections=new Map();results.questions.forEach((question,index) => { const section=question.section || 'Ответы на вопросы';if (!sections.has(section)) sections.set(section,[]);sections.get(section).push({question,index}); });
      sections.forEach((items,title) => content.append(node('details',{class:'result-section',open:!results.metrics?.length},node('summary',{},title,node('span',{class:'hint'},`${items.length} ${questionWord(items.length)}`)),items.map(({question,index}) => distribution(`${index+1}. ${question.title}`,question.options,question.scale_summary)))));
    }
    async function load(filters) {
      if (busy || !alive()) return;
      const sequence=++request;setBusy(true);errors.replaceChildren();
      try {
        const path=`/surveys/${encodeURIComponent(survey.id)}/results`;const results=filters===undefined ? await api(path) : await api(path,'POST',{filters});
        if (!alive() || sequence!==request) return;
        if (!applied) { body.replaceChildren(node('h3',{},survey.title),filterArea,appliedLabel,node('div',{class:'page-actions result-exports'},csv,json),errors,content,node('div',{class:'dialog-footer'},button('Закрыть',() => modal.close())));buildFilters(results); }
        applied=results;syncFilters(results);renderResults(results);
      } catch (error) {
        if (!alive() || sequence!==request) return;
        if (!applied) body.replaceChildren(errorBox(error,() => load()));else errors.replaceChildren(errorBox(error,() => load(readFilters())));
      } finally { if (alive() && sequence===request) setBusy(false); }
    }
    await load();
  }
  async function sharedStylesReady() {
    const link = document.getElementById('pl-ui-styles');
    const available = () => {
      try { return Boolean(link?.sheet?.cssRules.length); } catch (_) { return false; }
    };
    if (available()) return true;
    if (!link || document.readyState === 'complete') return false;
    // WebKit can execute deferred scripts before the linked stylesheet has a CSSOM.
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        link.removeEventListener('load', finish);
        link.removeEventListener('error', finish);
        window.removeEventListener('load', finish);
        resolve(available());
      };
      link.addEventListener('load', finish, {once:true});
      link.addEventListener('error', finish, {once:true});
      window.addEventListener('load', finish, {once:true});
      timer = setTimeout(finish, 8000);
      if (available() || document.readyState === 'complete') finish();
    });
  }
  async function start() {
    if (!window.PLUI || typeof window.PLUI.createShell !== 'function' || !(await sharedStylesReady())) {
      $('#boot').replaceChildren(errorBox(new Error('Не удалось загрузить интерфейс Платформы.'),() => location.reload()),node('a',{href:'/'},'Открыть Платформу'));
      return;
    }
    try { state.context=await api('/context'); shell(); await refresh(); }
    catch (error) { if (!$('#app').hidden && $('#main')) showPageError(error); else $('#boot').replaceChildren(errorBox(error,() => { $('#boot').textContent='Загружаем формы…'; start(); }),node('a',{href:'/'},'Открыть Платформу')); }
  }
  start();
})();
