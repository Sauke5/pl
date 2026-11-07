'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const Office = globalThis.PLOfficeView;
  const ElkLayout = globalThis.PLElkLayout;
  const TYPES = { camera:'Камера', recorder:'Видеорегистратор', next_hop:'Следующий узел маршрута', subnet:'Подсеть', client_group:'Группа подключений', observation_group:'Наблюдения порта', router: 'Маршрутизатор', firewall: 'Шлюз / firewall', switch: 'Коммутатор', server: 'Сервер', storage: 'СХД', passive: 'Оборудование стойки', esxi: 'Хост ESXi', vm: 'Виртуальная машина', vswitch: 'Виртуальный коммутатор', unknown: 'Устройство' };
  Object.assign(TYPES, {phone:'Телефон', computer:'Компьютер',printer:'Принтер',hub:'Хаб'});
  const FILTER_KINDS = ['camera','recorder','computer','phone','printer','hub','switch','router','firewall','server','storage','esxi','vm','vswitch','unknown','passive','subnet','next_hop'];
  const defaultKinds = () => new Set(FILTER_KINDS);
  const MAX_ENDPOINTS = 250;
  const STATUS = { up: 'Доступен', on: 'Включена', down: 'Недоступен', off: 'Выключена', observed: 'Есть сетевые данные', unknown: '—', stale: 'Данные устарели', ok: 'OK', success: 'OK', healthy: 'OK', error: 'Ошибка', failed: 'Ошибка', degraded: 'Частично', partial: 'Частично', warning: 'Внимание', disabled: 'Отключён', pending: 'Ожидание', active: 'Актуальная', documented: 'Подтверждено оператором', inactive: 'Неактивная', missing: 'Не обнаружена' };
  const state = { data: null, nodes: new Map(), selected: null, selectedRack: null, selectedEdge: null, branchRoot: null, focus: null, query: '', kinds: defaultKinds(), view: 'topology', viewChosen: false, positions: {}, pinned: new Set(), visible: [], visibleEdges: [], transform: { x: 0, y: 0, k: 1 }, fitted: false, lastError: null, loading: false };
  state.allDevices = false;
  state.showObservations = true;
  state.showAllLinks = true;
  state.officeExpanded = new Set();
  state.officeProjection = null;
  state.officeLayoutContexts = new Map();
  state.officeActiveContext = null;
  const demo = false;
  const config = globalThis.NETMAP_CONFIG || {title:'NetMap',default_scope:'network',platform_url:'/',scopes:[{id:'network',name:'Сеть',api:'./api/sites/network',grouped:false,rack:false}]};
  const scopeDefinitions = new Map(config.scopes.map(scope => [scope.id, scope]));
  const SCOPES = Object.fromEntries(config.scopes.map(scope => [scope.id, scope.name]));
  function scopeOptions() { return scopeDefinitions.get(state.scope) || {}; }
  function groupedScope() { return state.layout === 'groups'; }
  function rackScope() { return scopeOptions().rack === true; }
  const queryParams = new URLSearchParams(location.search);
  const requestedScope = queryParams.get('scope');
  const requestedDevice = queryParams.get('device');
  let initialDevice = /^(?:device|vm):[1-9][0-9]{0,14}$/.test(requestedDevice || '') ? requestedDevice : null;
  state.scope = Object.hasOwn(SCOPES, requestedScope) ? requestedScope : config.default_scope;
  state.layout = queryParams.get('layout') === 'groups' ? 'groups' : 'graph';
  $('layout-mode').value = state.layout;
  $('site-name').textContent = SCOPES[state.scope];
  $('tab-rack').hidden = !rackScope();
  $('page-subtitle').textContent = 'Устройства, интерфейсы и связи сети';
  document.title = `${SCOPES[state.scope]} · Инфраструктура`;
  const emptyInspector = $('inspector').innerHTML;
  const collator = new Intl.Collator('ru', { numeric: true });
  let saveTimer, pointer, requestController, filterTimer;

  function element(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'class') node.className = value;
      else node.setAttribute(name, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function statusClass(value) { return Object.hasOwn(STATUS, value) ? value : 'unknown'; }
  function factualNote(value) { return !/не подтверж|не определ|предполож|неизвест|не провер|требует подтверждения|unverified|unconfirmed|unknown/i.test(String(value)); }
  function vmPlacement(edge) {
    const relationship = edge.details?.relationship;
    return edge.kind === 'virtual' && relationship?.authority === 'netbox' && relationship.assurance === 'hosting';
  }
  function edgeKindLabel(edge) { return {routed:'Логическая маршрутизация',tunnel:'Туннель',virtual:'Виртуальная',observed:'Наблюдение',physical:'Физическая',lag:'Агрегированная'}[edge.kind] || ''; }
  function edgeConfidenceLabel(edge) { return {confirmed:'',inferred:'',observed:'',documented:'Из конфигурации'}[edge.confidence] || ''; }
  function tunnelEndpointRows(edge, side, label) {
    const d = edge.details || {};
    return [[`IP туннеля ${label}`,d[`${side}_tunnel_ip`]], [`Внешний порт ${label}`,d[`${side}_underlay_port`]], [`Внешний IP ${label}`,d[`${side}_underlay_ip`]]].filter(([,value]) => value != null && value !== '');
  }
  function edgeSummary(edge) { return [edgeKindLabel(edge), edgeConfidenceLabel(edge).toLowerCase(), edge.kind==='tunnel'||['stale','inactive','missing','documented'].includes(edge.status)?edgeStatusLabel(edge).toLowerCase():''].filter(Boolean).join(' · '); }
  function sourceUrl(scope) { return scopeDefinitions.get(scope)?.api || './api/sites/' + scope; }
  function projectScope(data, scope) {
    if (scope !== 'network' && !/^network-[a-f0-9]{16}$/.test(scope)) return data;
    const linked = new Set(data.edges.flatMap(edge => [edge.source, edge.target]));
    const ownersByAddress = new Map();
    for (const node of data.nodes) {
      if (!node.netbox_url && !node.id.startsWith('neighbor:')) continue;
      const ips = new Set([node.management_ip, ...nodeAddresses(node).map(item => item.address)]
        .filter(value => typeof value === 'string' && value).map(value => value.split('/')[0]));
      for (const ip of ips) {
        if (!ownersByAddress.has(ip)) ownersByAddress.set(ip, []);
        ownersByAddress.get(ip).push(node);
      }
    }

    // Combine presentation of bare reachability checks. Keep the source graph
    // available to discovery and leave inventoried devices and edges intact.
    const addressAliases = new Map(), checks = new Map();
    for (const node of data.nodes) {
      const ip = node.management_ip, details = node.details;
      const networkId = /^network:([a-f0-9]{16})$/.exec(details.source)?.[1];
      if (!networkId || !ip || node.id !== `observed:${networkId}:${ip}` ||
          (scope !== 'network' && scope !== `network-${networkId}`) ||
          node.name !== ip || linked.has(node.id) || details.reports?.length || details.mac ||
          !Array.isArray(details.observation_methods) || !details.observation_methods.length) continue;

      const owners = (ownersByAddress.get(ip) || []).filter(owner =>
        !/^network:/.test(owner.details.source) || owner.details.source === details.source);
      if (owners.length !== 1) continue;
      const [owner] = owners;
      if (owner.id.startsWith('neighbor:') && !owner.details.reports?.some(report =>
        report.address === ip && (report.state === 'reported' ||
          Date.parse(report.observed_at) >= Date.parse(details.last_seen)))) continue;

      addressAliases.set(node.id, owner.id);
      if (!checks.has(owner.id)) checks.set(owner.id, new Map());
      const addresses = checks.get(owner.id), previous = addresses.get(ip);
      if (!previous || Date.parse(details.last_seen) > Date.parse(previous.last_seen) ||
          details.last_seen === previous.last_seen && details.observation_state === 'observed') {
        addresses.set(ip, {ip, methods: details.observation_methods, state: details.observation_state, last_seen: details.last_seen});
      }
    }
    if (!addressAliases.size) return data;
    const nodes = data.nodes.filter(node => !addressAliases.has(node.id)).map(node =>
      checks.has(node.id) ? {...node, addressChecks: [...checks.get(node.id).values()]} : node);
    return {...data, nodes, addressAliases};
  }
  function ruPlural(count, one, few, many) { const n=Math.abs(count)%100, last=n%10; return n>=11 && n<=14 ? many : last===1 ? one : last>=2 && last<=4 ? few : many; }
  function edgeStatusLabel(edge) { if (edge.kind === 'physical' && edge.status === 'documented' && edge.details?.relationship?.authority === 'netbox') return 'Зарегистрирована в NetBox'; if (edge.kind === 'routed' && edge.status === 'documented') return 'Настроено на AR'; return edge.kind === 'tunnel' && edge.status === 'documented' ? 'Есть конфигурация туннеля' : statusLabel(edge.status); }
  function sourceStatusLabel(source) { return !source.last_success && ['error','failed','stale'].includes(source.status) ? 'Ошибка опроса' : statusLabel(source.status); }
  function statusLabel(value) { return STATUS[value] || 'Неизвестно'; }
  function dot(value) { return element('span', { class: `status-dot ${statusClass(value)}`, 'aria-hidden': 'true' }); }
  function date(value) {
    const d = new Date(value);
    return value && Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }) : 'Нет успешного сбора';
  }
  function age(value) { const t = Date.parse(value); return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity; }
  function observationAge(value) {
    const elapsed=age(value);
    if(!Number.isFinite(elapsed))return '';
    const minutes=Math.floor(elapsed/60000);
    if(minutes<1)return 'меньше минуты назад';
    if(minutes<60)return `${minutes} мин назад`;
    const hours=Math.floor(minutes/60);
    return hours<24?`${hours} ч ${minutes%60} мин назад`:`${Math.floor(hours/24)} д ${hours%24} ч назад`;
  }
  function portStatus(port) {
    if(port.admin_up===false || port.oper_up===false)return 'down';
    if(port.oper_up===true)return 'up';
    return ['up','down'].includes(port.status)?port.status:'unknown';
  }
  function portVlanLabel(port) {
    const untagged=port.untagged_vlans??port.untagged_vlan??port.vlan;
    const native=Array.isArray(untagged)?untagged.join(', '):plain(untagged);
    const tagged=Array.isArray(port.tagged_vlans)?port.tagged_vlans.join(', '):port.tagged_vlans;
    if(tagged || Array.isArray(port.untagged_vlans))return `U: ${native || '—'}; T: ${tagged || '—'}`;
    return Array.isArray(port.vlan)?port.vlan.filter(v=>v!=null).join(', ') || '—':native;
  }
  function portFacts(node,name) {
    const port=(node?.ports || []).find(p=>p.name===name);
    if(!port)return [];
    const status=portStatus(port),facts=[status==='up'?'Линк Up':status==='down'?'Линк Down':''];
    if(typeof port.admin_up==='boolean')facts.push(port.admin_up?'Admin Up':'Admin Down');
    const at=node.details?.direct_poll?.last_success || node.last_seen;
    if(at)facts.push(`${date(at)} · ${observationAge(at)}`);
    return facts.filter(Boolean);
  }
  function plain(value) { return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
  function safeLink(value) {
    if (!value) return null;
    try { const u = new URL(value, location.origin); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
  }
  function nodeTypeLabel(node) {
    if (node.details?.observation_methods) return node.management_ip ? 'Наблюдаемый адрес' : 'Наблюдаемое устройство';
    if (node.kind === 'unknown' && (/^Сегмент/i.test(node.name || '') || (node.details?.macs || []).length > 1)) return 'Сегмент';
    return TYPES[node.kind] || 'Устройство';
  }
  function nodeName(node) {
    return node.name && !/^Неопознанн(?:ое устройство|ый узел)$/.test(node.name) ? node.name : nodeTypeLabel(node);
  }
  function rackIdentityLabel(item, node) {
    if (item.identity_status === 'confirmed' && node) return node.name;
    return item.label || 'Оборудование';
  }
  function confirmedRackPlacement(nodeId) {
    const records = (state.data?.rack_items || []).filter(item => item.identity_status === 'confirmed');
    const own = records.find(item => item.node_id === nodeId);
    if (own) return { item: own, member: false };
    const parent = records.find(item => (item.member_node_ids || []).includes(nodeId));
    return parent ? { item: parent, member: true } : null;
  }
  function nodeSite(node) { return node.site_name || node.site?.name || node.details?.site?.name || (typeof node.details?.site === 'string' ? node.details.site : '') || ''; }
  const ADDRESS_ROLES = {primary:'Основной',management:'Управление',bmc:'BMC',production:'Рабочая сеть',reserve:'Резервный',interface:'Интерфейс',uplink:'Uplink',observed:'Наблюдение'};
  function identityConfidence(identity) {
    const labels = [];
    if (identity.source === 'dns-ptr' && identity.forward_confirmed === true) labels.push('A/PTR');
    else if (identity.source === 'dns-ptr' && identity.forward_confirmed === false) labels.push('PTR');
    if (identity.stale === true || identity.status === 'stale') labels.push('Устарело');
    return labels.join(' · ');
  }
  function addressRole(role) { return ADDRESS_ROLES[role] || 'Интерфейс'; }
  function nodeAddresses(node) {
    if (Array.isArray(node.addresses)) return node.addresses;
    const result = [], seen = new Set();
    function add(value, port, role) {
      const address = typeof value === 'object' ? value.address || value.ip : value;
      if (!address) return;
      const key = String(address).split('/')[0] + '|' + (port || '');
      if (seen.has(key)) return; seen.add(key);
      result.push({address:String(address),interface:port || '',role});
    }
    add(node.management_ip, '', 'management');
    if (node.kind !== 'switch') for (const p of node.ports || []) {
      const role = /bmc|idrac|ipmi/i.test(p.name) ? 'bmc' : /reserve|backup/i.test(p.name) ? 'reserve' : 'interface';
      for (const ip of p.ips || []) add(ip, p.name, role);
      add(p.observed_ip, p.name, role);
    }
    return result;
  }
  function nodeSub(node) {
    if (node._officeGroup) return node.subtitle || '';
    if (node.kind === 'observation_group') return 'FDB';
    if (node.kind === 'unknown') {
      const vendors = [...new Set([node.details?.vendor, ...(node.details?.identities || []).map(identity => identity.vendor)].filter(Boolean))];
      if (vendors.length) return vendors.join(' · ');
      const macs = node.details?.macs || node.macs;
      if (Array.isArray(macs) && macs.length) return `${macs[0]}${macs.length>1 ? ' +'+(macs.length-1) : ''}`;
      return node.details?.mac || node.mac || node.management_ip || '';
    }
    const addresses = nodeAddresses(node);
    if (addresses.length) return addresses[0].address + (addresses.length > 1 ? ' · +' + (addresses.length - 1) + ' IP' : '');
    return [node.management_ip,node.details?.hardware?.model,node.details?.model,TYPES[node.kind]].find(value=>value && factualNote(value)) || '';
  }
  function searchable(node) { return [...nodeAddresses(node).flatMap(a => [a.address, a.ip, a.interface, addressRole(a.role)]), node.name, nodeSite(node), node.management_ip, node.id, ...Object.values(node.details || {}), ...(node.ports || []).flatMap(p => [p.name, p.mac])].map(plain).join(' ').toLowerCase(); }
  function displayData() { return state.data; }
  function typeFilterKey() { return [...state.kinds].sort().join(',')+':devices='+state.allDevices+':observations='+state.showObservations; }
  function typeFiltering() { return state.allDevices || !state.showObservations || FILTER_KINDS.some(kind=>!state.kinds.has(kind)); }
  function observationVisible(node) { return state.showObservations || !Office.isSummary(node); }
  function matches(node) { return (Office.isSummary(node) ? state.showObservations : state.kinds.has(node.kind)) && (!state.query || searchable(node).includes(state.query)); }
  function syncTypeControls() { $('show-observations').checked=state.showObservations; for (const kind of FILTER_KINDS) $('kind-'+kind).checked=state.kinds.has(kind); }
  function renderTypeControls() {
    const counts=new Map();
    for(const node of state.data.nodes.filter(node=>!Office.isSummary(node))) counts.set(node.kind,(counts.get(node.kind)||0)+1);
    $('show-observations').checked=state.showObservations;
    $('observation-count').textContent=String(state.data.nodes.filter(Office.isSummary).length);
    for(const kind of FILTER_KINDS) {
      const input=$('kind-'+kind), count=counts.get(kind)||0;
      input.checked=state.kinds.has(kind);input.closest('label').hidden=false;
      $('kind-count-'+kind).textContent=String(count);
    }
  }
  function cancelFilterRender() { clearTimeout(filterTimer);filterTimer=null; }
  function renderPathSummary() {
    const box=$('path-summary'), context=state.pathContext, notes=[];
    if(context?.limitApplied) notes.push(`Показано ${context.shownHitCount} из ${context.totalHitCount} найденных устройств. Уточните поиск, чтобы увидеть остальные.`);
    if(state.query && context?.nodeIds?.size) {
      const gateways=[...context.gatewayIds].map(id=>nodeName(state.nodes.get(id))).join(', ');
      if(gateways) notes.push(`Цепочка подключений: ${gateways}.`);
    }
    box.hidden=!notes.length;box.textContent=notes.join(' ');
  }
  function children(id, kind) {
    return [...state.nodes.values()].filter(n => (!kind || n.kind === kind) && isDescendant(n, id));
  }
  function isDescendant(node, id) {
    const seen = new Set();
    let current = node;
    while (current?.parent_id && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parent_id === id) return true;
      current = state.nodes.get(current.parent_id);
    }
    return false;
  }
  function persistKey() { return `pl-ui-topology-layout-v5:${state.scope}:${state.layout}:${state.officeActiveContext || 'overview'}`; }
  function loadPositions() {
    try {
      const p = JSON.parse(localStorage.getItem(persistKey()) || '{}');
      state.positions = Object.fromEntries(Object.entries(p).filter(([,v]) => Number.isFinite(v?.x) && Number.isFinite(v?.y)));
      state.pinned = new Set(Object.keys(state.positions));
    } catch { state.positions = {}; }
  }
  function savePositions() {
    clearTimeout(saveTimer);
    const key = persistKey(), positions = JSON.stringify(Object.fromEntries(Object.entries(state.positions).filter(([id])=>state.pinned.has(id))));
    saveTimer = setTimeout(() => { try { localStorage.setItem(key, positions); } catch { /* Storage may be disabled. */ } }, 200);
  }
  function effectiveKind(node) {
    const kind=Object.hasOwn(TYPES,node.kind) ? node.kind : 'unknown', hint=node.details?.identity_hint;
    return kind==='unknown' && hint?.status==='suggested' && ['medium','high'].includes(hint.confidence) &&
      ['phone','computer','printer','camera','recorder','hub','switch','router','server','storage'].includes(hint.suggested_kind) ? hint.suggested_kind : kind;
  }
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error('Источник вернул некорректную структуру данных');
    const nodes = raw.nodes.map(n => ({ ...n, id: String(n.id), parent_id: n.parent_id == null ? null : String(n.parent_id), kind: effectiveKind(n), details: n.details || {}, ports: Array.isArray(n.ports) ? n.ports : [] }));
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('В данных обнаружены повторяющиеся идентификаторы устройств');
    return { ...raw, sources: Array.isArray(raw.sources) ? raw.sources.filter(source=>source.polling_enabled!==false && source.status!=='disabled') : [], nodes, edges: raw.edges.map(e => ({ ...e, id: String(e.id), source: String(e.source), target: String(e.target), evidence: Array.isArray(e.evidence) ? e.evidence : [] })), rack_items: (raw.rack_items || []).map(i => ({ ...i, id: String(i.id), node_id: i.node_id == null ? null : String(i.node_id), member_node_ids: Array.isArray(i.member_node_ids) ? i.member_node_ids.map(String) : [] })) };
  }
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    $('refresh').disabled = true;
    requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), 15000);
    try {
      const response = await fetch(demo ? './fixture.json' : sourceUrl(state.scope), { cache: 'no-store', signal: requestController.signal, credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`API: HTTP ${response.status}`);
      const payload = await response.text();
      if (state.data && state.lastPayload === payload) { state.lastError = null; renderFreshness(); if(state.layoutError)renderGraph();return; }
      const next = projectScope(normalize(JSON.parse(payload)), state.scope);
      const first = !state.data;
      const oldSignature = state.data?.nodes.map(n => n.id).sort().join('|');
      state.data = next;
      state.nodes = new Map(next.nodes.map(n => [n.id, n]));
      state.lastError = null;
      if (first) {
        loadPositions();
        if (initialDevice && state.nodes.has(initialDevice)) state.selected = initialDevice;
        initialDevice = null;
      }
      if (state.selected && !state.nodes.has(state.selected)) state.selected = next.addressAliases?.get(state.selected) || null;
      // Topology is the default in every scope. An explicit rack-tab choice
      // stays active through refreshes, but does not carry into another scope.
      renderAll(first || oldSignature !== next.nodes.map(n => n.id).sort().join('|'));
      state.lastPayload = payload;
    } catch (error) {
      state.lastError = error.name === 'AbortError' ? 'Источник не ответил за 15 секунд' : error.message;
      renderFreshness();
      if (!state.data) {
        $('counts').textContent = 'Данные недоступны';
        $('graph-empty').hidden = false;
        $('graph-empty').querySelector('strong').textContent = 'Не удалось загрузить топологию';
        $('graph-empty').querySelector('p').textContent = 'Проверьте источник и нажмите «Обновить».';
      }
    } finally { clearTimeout(timeout); state.loading = false; $('refresh').disabled = false; }
  }
  function renderFreshness() {
    const timestamp = state.data?.generated_at;
    $('refresh-note').textContent = state.data?.provenance?.kind === 'evidence-import' ? 'Датированный снимок · повторный импорт' : 'Автообновление каждые 30 секунд';
    $('updated-at').textContent = date(timestamp);
    if (timestamp) $('updated-at').dateTime = timestamp;
    const sourceErrors = state.data?.sources.filter(s => ['error','failed','degraded','partial','stale'].includes(s.status)) || [];
    const old = state.data?.provenance?.kind !== 'evidence-import' && age(timestamp) > 15 * 60 * 1000;
    $('freshness-label').textContent = state.lastError ? 'Обновление недоступно' : !timestamp ? 'Ожидание данных' : old ? 'Снимок устарел' : 'Последний снимок';
    $('notice').hidden = !(state.lastError || (timestamp && old) || sourceErrors.length);
    if (state.lastError) $('notice').textContent = `${state.lastError}.${state.data ? ' Показан последний снимок.' : ''}`;
    else if (timestamp && old) $('notice').textContent = 'Снимок старше 15 минут.';
    else if (sourceErrors.length) { const reasons=[...new Set(sourceErrors.map(s=>s.error).filter(Boolean))]; $('notice').textContent = `${sourceErrors.length} ${ruPlural(sourceErrors.length,'источник не обновляется','источника не обновляются','источников не обновляются')}${reasons.length===1?' · '+reasons[0]:''}. Подробности — в панели «Источники».`; }
    $('footer-status').textContent = state.lastError ? 'Ошибка обновления · сохранён последний снимок' : timestamp ? `Снимок: ${date(timestamp)}` : 'Данные ещё не получены';
  }
  function renderSources() {
    const root = $('sources'); root.replaceChildren();
    $('source-count').textContent = state.data.sources.length ? `· ${state.data.sources.length}` : '';
    if (!state.data.sources.length) root.append(element('p', { class: 'muted' }, 'Состояние источников не передано'));
    for (const source of state.data.sources) {
      const row = element('div', { class: 'source' });
      const header = element('div', { class: 'source-header' });
      header.append(dot(source.status), element('span', { class: 'source-name' }, source.name || source.id), element('span', { class: 'source-status' }, sourceStatusLabel(source)));
      row.append(header, element('time', {}, date(source.last_success)));
      if (source.error) row.append(element('p', { class: 'source-error' }, plain(source.error)));
      root.append(row);
    }
  }
  function renderAll(refit = false) {
    const site = state.data.site || {};
    $('site-name').textContent = site.name || 'Инфраструктура';
    document.title = `${site.name || 'Инфраструктура'} · Оборудование и связи`;
    $('page-subtitle').textContent = 'Устройства, интерфейсы и связи сети';
    $('tab-rack').hidden = !rackScope();
    renderTypeControls();
    const total=state.data.nodes.length, links=state.data.edges.length;
    $('counts').textContent = `${total} ${ruPlural(total,'узел','узла','узлов')} · ${links} ${ruPlural(links,'связь','связи','связей')}`;
    const coverage = state.data.coverage;
    $('coverage').hidden = false;
    if (rackScope() && Number.isFinite(coverage?.rack_positions) && Number.isFinite(coverage?.rack_matched)) $('coverage').textContent = `Сопоставлено ${coverage.rack_matched}/${coverage.rack_positions} позиций${Number.isFinite(coverage.physical_links) ? ' · '+coverage.physical_links+' физических связей' : ''}${Number.isFinite(coverage.virtual_machines) ? ' · '+coverage.virtual_machines+' ВМ' : ''}`;
    else {
      const inventory = state.data.nodes.filter(node => node.netbox_url || node.id.startsWith('device:')).length;
      const observed = state.data.nodes.length - inventory;
      const successful = state.data.sources.filter(source => ['ok','success','healthy'].includes(source.status)).length;
      $('coverage').textContent = `${inventory} узлов в инвентаризации · ${observed} обнаруженных узлов · ${state.data.edges.length} связей · источники OK ${successful}/${state.data.sources.length}`;
    }
    const warnings = Array.isArray(state.data.warnings) ? state.data.warnings : [];
    $('data-warnings').hidden = !warnings.length;
    $('warnings-summary').textContent = `Замечания к данным · ${warnings.length}`;
    $('map-status-summary').textContent = warnings.length ? `Состояние · ${warnings.length}` : 'Состояние';
    $('map-status-summary').classList.toggle('has-warning',Boolean(warnings.length));
    $('warnings-list').replaceChildren(...warnings.map(w=>element('li',{},plain(w))));
    renderFreshness(); renderSources(); renderGraph(refit); renderRack(); renderInspector(); showView(state.view, false);
  }
  function filterNodes() {
    state.pathContext=null;
    const data=displayData();
    const scope=state.focus ? neighbors(state.focus.id) : null;
    if(state.focus?.mode==='subtree') for(const child of children(state.focus.id)) scope.add(child.id);
    if(scope) return data.nodes.filter(node=>scope.has(node.id) && observationVisible(node));
    if(state.query || typeFiltering()) {
      const hits=new Set(data.nodes.filter(node=>matches(node)).map(node=>node.id));
      state.pathContext=Office?.pathContext?.(data,hits,{maxEndpoints:MAX_ENDPOINTS});
      const ids=state.pathContext?.nodeIds || hits;
      return data.nodes.filter(node=>ids.has(node.id) && (observationVisible(node) || Boolean(state.query)));
    }
    return data.nodes.filter(observationVisible);
  }
  function adaptiveColumns(count, width, height) {
    if (count <= 1) return Math.max(1,count);
    const aspect = Math.max(.5, width / Math.max(1,height));
    return Math.min(count,Math.max(1,Math.ceil(Math.sqrt(count * aspect * 150 / 300))));
  }
  function layout(nodes) {
    if (groupedScope() && Office) {
      let levels=Office.networkLevels(state.data);
      if(state.officeProjection?.mode !== 'overview') {
        const networkNodes=nodes.filter(Office.isNetwork).sort((a,b)=>collator.compare(a.id,b.id));
        levels=new Map(networkNodes.map(node=>[node.id,node.id===state.focus?.id?0:1]));
      }
      const rows=new Map();
      for(const [id,level] of levels) {if(!rows.has(level))rows.set(level,[]);rows.get(level).push(id);}
      const width=$('graph-wrap').getBoundingClientRect?.().width || 1400;
      const columns=Math.max(2,Math.min(8,Math.floor((width-100)/320)));
      let rowY=65;
      for(const [level,ids] of [...rows].sort(([a],[b])=>a-b)) {
        ids.sort((a,b)=>collator.compare(state.nodes.get(a)?.name || a,state.nodes.get(b)?.name || b));
        const count=Math.min(columns,ids.length);
        ids.forEach((id,i)=>{if(!state.positions[id])state.positions[id]={x:(i%columns-(count-1)/2)*320,y:rowY+Math.floor(i/columns)*200};});
        rowY+=Math.ceil(ids.length/columns)*200+30;
      }
      const byOwner=new Map();
      for(const node of nodes) if(!levels.has(node.id) && !state.positions[node.id]) {
        const owners = node._officeGroup?.owner ? [node._officeGroup.owner] : state.officeProjection?.index.owners(node.id).owners || [];
        const owner=state.focus?.id || owners[0] || 'unassigned';if(!byOwner.has(owner))byOwner.set(owner,[]);byOwner.get(owner).push(node);
      }
      const visibleIds=new Set(nodes.map(n=>n.id));
      const occupied=Object.entries(state.positions).filter(([id])=>visibleIds.has(id)).map(([,p])=>p);
      const bottom=Math.max(0,...[...levels.keys()].map(id=>state.positions[id]?.y || 0))+250;
      let section=0;
      for(const [owner,items] of [...byOwner].sort(([a],[b])=>collator.compare(a,b))) {
        const base=state.positions[owner] || {x:section++*300,y:bottom};
        items.sort((a,b)=>collator.compare(a.id,b.id)).forEach((node,i)=>{
          let position={x:base.x+(i%4-1.5)*320,y:bottom+Math.floor(i/4)*180};
          if(node._officeGroup) {
            const ownerLevel=levels.get(owner), networkChildren=state.data.edges.filter(e=>e.source===owner || e.target===owner).map(e=>e.source===owner?e.target:e.source).filter(id=>levels.get(id)>ownerLevel);
            position={x:base.x,y:base.y+150};
            // A core's fan of links starts below its card; keep its group beside
            // the core when that row has space, outside the outgoing fan.
            if(networkChildren.length>1 && (rows.get(ownerLevel)||[]).length===1)position={x:base.x+300,y:base.y};
          }
          else while(occupied.some(p=>Math.abs(p.x-position.x)<275 && Math.abs(p.y-position.y)<135))position.y+=150;
          state.positions[node.id]=position;occupied.push(position);
        });
      }
      return;
    }
    const canvas = $('graph-wrap').getBoundingClientRect();
    const lanColumns = adaptiveColumns(nodes.length,canvas.width || 1000,canvas.height || 640);
    const rank = { router: 0, firewall: 0, switch: 1, server: 2, storage: 2, passive: 2, esxi: 2, unknown: 2, vswitch: 3, vm: 4 };
    const groups = new Map();
    for (const n of nodes) { const r = rank[n.kind] ?? 2; if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
    let y = 65;
    for (const r of [...groups.keys()].sort((a,b) => a-b)) {
      const group = groups.get(r).sort((a,b) => collator.compare(a.parent_id || '', b.parent_id || '') || collator.compare(a.name || a.id, b.name || b.id));
      const columns = Math.min(group.length, lanColumns);
      group.forEach((node, i) => {
        if (!state.pinned.has(node.id)) state.positions[node.id] = { x: (i % columns - (columns-1)/2) * 300, y: y + Math.floor(i / columns) * 150 };
      });
      y += Math.ceil(group.length / columns) * 150 + 75;
    }
  }
  function neighbors(id) {
    const result = new Set([id]);
    for (const e of displayData().edges) { if (e.source === id) result.add(e.target); if (e.target === id) result.add(e.source); }
    return result;
  }
  function officeLayoutContext() {
    const key=state.focus ? 'local:'+state.focus.id : state.query || typeFiltering() ? 'search:'+state.query+':'+typeFilterKey() : 'overview';
    if(key===state.officeActiveContext)return;
    if(state.officeActiveContext) state.officeLayoutContexts.set(state.officeActiveContext,{positions:state.positions,pinned:state.pinned});
    const cached=state.officeLayoutContexts.get(key);
    if(state.officeActiveContext || key!=='overview') {
      state.positions=cached?.positions || {};state.pinned=cached?.pinned || new Set();
    }
    state.officeActiveContext=key;state.fitted=false;
    if(!cached && key!=='overview')loadPositions();
  }
  function elkEnabled() { return true; }
  function elkStorageKey() { return `pl-ui-topology-elk-v2:${state.scope}:${state.layout}:${state.officeActiveContext || 'overview'}`; }
  function saveElkGeometry() {
    if (!state.elkGeometry) return;
    try { localStorage.setItem(elkStorageKey(),JSON.stringify(state.elkGeometry)); } catch { /* Storage is optional. */ }
  }
  async function resolveElkGeometry(interactive = false) {
    const canvas=$('graph-wrap').getBoundingClientRect(), ranks={};
    const levels=Office.networkLevels(displayData());
    for(const node of state.visible) {
      ranks[node.id]=Office.isNetwork(node) ? (state.focus ? node.id===state.focus.id?0:1 : levels.get(node.id) || 0) : ({next_hop:50,vswitch:110,vm:120,subnet:130}[node.kind] ?? 100);
    }
    const input={nodes:state.visible,edges:state.visibleEdges,ranks,scope:state.scope,
      width:canvas.width || 1400,height:canvas.height || 800,
      ...(interactive?{interactive:true,previous:state.positions}:{})};
    const key=ElkLayout.keyFor({...input,interactive:false,previous:undefined});
    if(!interactive) {
      if(state.elkGeometry?.key===key) return state.elkGeometry;
      try {
        const saved=JSON.parse(localStorage.getItem(elkStorageKey()) || 'null');
        if(saved?.key===key && state.visible.every(n=>Number.isFinite(saved.positions?.[n.id]?.x)&&Number.isFinite(saved.positions?.[n.id]?.y)) && state.visibleEdges.every(e=>saved.routes?.[e.id]?.points?.length>=2 && saved.routes[e.id].points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)) && Number.isFinite(saved.routes[e.id].label?.x) && Number.isFinite(saved.routes[e.id].label?.y))) return saved;
      } catch { /* Invalid/disabled storage is ignored. */ }
    }
    const result=await ElkLayout.layout(input);
    result.key=key;
    return result;
  }
  async function renderGraph(refit = false, interactive = false) {
    cancelFilterRender();
    if (!state.data) return;
    if(elkEnabled() && pointer?.kind==='node' && pointer.moved) {state.pendingElkRefit=refit || state.pendingElkRefit;return;}
    $('graph').dataset.scope=state.scope;
    const data=displayData();state.nodes=new Map(data.nodes.map(node=>[node.id,node]));
    const generation=(state.layoutGeneration || 0)+1, layoutScope=state.scope;state.layoutGeneration=generation;
    if (groupedScope() && Office) {
      officeLayoutContext();
      const hits = state.query || typeFiltering() ? new Set(data.nodes.filter(node=>matches(node)).map(n=>n.id)) : null;
      state.officeProjection = Office.project(data,{expanded:state.officeExpanded,focusId:state.focus?.id,hits,maxEndpoints:MAX_ENDPOINTS,compactGroups:false,showAllLinks:state.showAllLinks});
      state.visible = state.officeProjection.nodes.filter(node=>observationVisible(node) || Boolean(state.query));
      const visibleIds=new Set(state.visible.map(node=>node.id));
      state.visibleEdges = state.officeProjection.edges.filter(edge=>visibleIds.has(edge.source) && visibleIds.has(edge.target));
      state.pathContext=state.officeProjection.context;
    } else {
      state.officeProjection = null;state.visible = filterNodes();
      const ids = new Set(state.visible.map(n => n.id));
      state.visibleEdges = data.edges.filter(e => ids.has(e.source) && ids.has(e.target) && (!state.pathContext || state.pathContext.edgeIds.has(e.id)));
    }
    if(elkEnabled()) {
      $('graph').setAttribute('aria-busy','true');
      try {
        const geometry=await resolveElkGeometry(interactive);
        if(generation!==state.layoutGeneration || layoutScope!==state.scope)return;
        state.elkGeometry=geometry;state.positions={...geometry.positions};state.pinned.clear();
        if(state.layoutError && !state.lastError){$('notice').hidden=true;$('notice').textContent='';}
        state.layoutError=false;
        saveElkGeometry();
        $('graph').dataset.layoutEngine='elkjs@0.12.0';
      } catch(error) {
        if(generation!==state.layoutGeneration || layoutScope!==state.scope)return;
        console.error('Topology layout failed',error);
        state.layoutError=true;
        $('notice').hidden=false;$('notice').textContent='Не удалось перестроить карту. Повторите действие.';
        // Keep the last complete, routed view rather than publishing partial geometry.
        $('graph').setAttribute('aria-busy','false');
        return;
      }
      $('graph').setAttribute('aria-busy','false');
    } else {state.elkGeometry=null;layout(state.visible);$('graph').dataset.layoutEngine='legacy';$('graph').setAttribute('aria-busy','false');}
    renderPathSummary();
    $('office-overview').hidden = !groupedScope();
    $('office-overview').textContent = 'Обзор';
    $('office-collapse').hidden = !groupedScope() || !state.officeExpanded.size;
    $('show-all').textContent = groupedScope() ? 'Обзор' : 'Вся карта';
    $('graph-empty').hidden = state.visible.length > 0;
    $('graph-empty').querySelector('strong').textContent = 'Устройства не найдены';
    $('graph-empty').querySelector('p').textContent = 'Измените фильтры или проверьте состояние источников.';
    if($('show-all-links-row'))$('show-all-links-row').hidden=!groupedScope();
    if($('show-all-links'))$('show-all-links').checked=state.showAllLinks;
    $('graph-description').textContent = `${state.visible.length} на карте · ${state.visibleEdges.length} ${ruPlural(state.visibleEdges.length,'связь','связи','связей')}${state.branchRoot ? ' · раскрыта группа ВМ' : ''}`;
    $('show-all').hidden = groupedScope() || !state.focus;
    const nodeRoot = $('nodes'), edgeRoot = $('edges'); nodeRoot.replaceChildren(); edgeRoot.replaceChildren();
    state.edgeElements = new Map(); state.nodeElements = new Map();
    prepareEdgeGeometry();
    const viewingWholeGroup = state.focus?.mode === 'subtree' && state.selected === state.focus.id;
    const near = state.selected && state.nodes.get(state.selected)?.kind !== 'passive' && !viewingWholeGroup ? neighbors(state.selected) : null;
    state.visibleEdges.forEach((edge, i) => {
      const related = state.selected && (edge.source === state.selected || edge.target === state.selected);
      const edgeKind = ['physical','virtual','lag','observed','tunnel','aggregation','routed'].includes(edge.kind) ? edge.kind : 'observed';
      const placement = vmPlacement(edge);
      const group = svg('g', { class: `edge ${edgeKind} ${edge.kind === 'routed' && edge.details?.virtual_gateway ? 'vm-gateway' : ''} ${edge.confidence === 'inferred' ? 'inferred' : ''} ${['stale','missing','inactive','down'].includes(edge.status) ? edge.status : ''} ${related || edge.id === state.selectedEdge ? 'highlight' : ''} ${edge.id === state.selectedEdge ? 'selected-edge' : ''} ${edge.details?.relationship?.conflicts?.length ? 'conflict' : ''} ${near && !related ? 'dimmed' : ''}`, 'data-edge': edge.id, tabindex:'0', role:'button', 'aria-label': placement ? 'Размещение ВМ' : `Связь ${edge.source_port || ''} — ${edge.target_port || ''}` });
      group.append(svg('path', { class: 'edge-path' }), svg('path', { class: 'edge-hit' }));
      const label = svg('g', { class: 'edge-label' }); label.append(svg('text', { 'text-anchor': 'middle' }, edge.label || (placement ? 'Размещение ВМ' : edge.kind === 'aggregation' ? 'Группа подключений' : `${edge.source_port || '—'} ↔ ${edge.target_port || '—'}`))); group.append(label);
      group.addEventListener('pointerenter', ev => showEdgeTooltip(edge, ev));
      group.addEventListener('pointermove', ev => moveTooltip(ev));
      group.addEventListener('pointerleave', () => { $('graph-tooltip').hidden = true; });
      group.addEventListener('click', ev => { ev.stopPropagation(); if(edge._officeGroup){if(edge._officeGroup.owner)selectNode(edge._officeGroup.owner);else expandOfficeGroup(edge._officeGroup.id);return;} state.selectedEdge = edge.id; state.selected = null; state.selectedRack = null; renderGraph(); renderInspector(); });
      group.addEventListener('keydown',ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); group.dispatchEvent(new MouseEvent('click')); $('inspector').querySelector('.detail-close')?.focus(); } });
      edgeRoot.append(group); state.edgeElements.set(edge.id,group); edgeGeometry(group, edge, i);
    });
    for (const node of state.visible) {
      const p = state.positions[node.id];
      const group = svg('g', { class: `node ${node.kind} ${state.selected === node.id ? 'selected' : near?.has(node.id) ? 'neighbor' : near ? 'dimmed' : ''} ${state.query && matches(node) ? 'focus-match' : ''}`, transform: `translate(${p.x},${p.y})`, 'data-node': node.id, tabindex: '0', role: 'button', 'aria-label': `${nodeName(node)}, ${nodeSub(node)}. Открыть сведения` });
      group.append(svg('rect', { class: 'node-card', x: -130, y: -54, width: 260, height: 128, rx: 12 }), svg('rect', { class: 'node-icon-bg', x: -87, y: -22, width: 30, height: 30, rx: 7 }));
      const icon = svg('g', { class: 'node-icon', transform: 'translate(-81,-16)' });
      if (node.kind === 'router' || node.kind === 'next_hop') icon.append(svg('circle',{cx:9,cy:9,r:8}),svg('path',{d:'M9 2v5m0 4v5M2 9h5m4 0h5M6 4l3-3 3 3M6 14l3 3 3-3M4 6L1 9l3 3M14 6l3 3-3 3'}));
      else if (node.kind === 'subnet') icon.append(svg('rect',{x:5,y:1,width:8,height:5,rx:1}),svg('path',{d:'M9 6v4M2 10h14M2 10v3m7-3v3m7-3v3'}),svg('rect',{x:0,y:13,width:4,height:4,rx:1}),svg('rect',{x:7,y:13,width:4,height:4,rx:1}),svg('rect',{x:14,y:13,width:4,height:4,rx:1}));
      else if (node.kind === 'firewall') icon.append(svg('path', { d: 'M9 0L17 3V9C17 14 12 17 9 18C6 17 1 14 1 9V3Z M5 9L8 12L13 6' }));
      else if (node.kind === 'camera') icon.append(svg('rect',{x:0,y:4,width:12,height:10,rx:2}),svg('path',{d:'M12 7L18 3V15L12 11'}));
      else if (node.kind === 'phone') icon.append(svg('path',{d:'M4 1L1 3C1 10 8 17 15 17L17 14L13 10L11 12C8 11 6 9 5 6L7 4Z'}));
      else if (node.kind === 'unknown') icon.append(svg('path', { d: 'M6 5C6 1 13 1 13 5C13 8 9 8 9 11 M9 15V16' }), svg('circle', { cx: 9, cy: 9, r: 9 }));
      else if (node.kind === 'vm' || node.kind === 'vswitch' || node.kind === 'computer') icon.append(svg('rect', { x: 1, y: 1, width: 16, height: 12, rx: 2 }), svg('path', { d: 'M6 17H12 M9 13V17' }));
      else icon.append(svg('rect', { x: 0, y: 1, width: 18, height: 7, rx: 2 }), svg('rect', { x: 0, y: 11, width: 18, height: 7, rx: 2 }), svg('path', { d: 'M4 4V5 M7 4V5 M4 14V15 M7 14V15 M13 4H15 M13 14H15' }));
      if (nodeSite(node)) group.append(svg('text', {class:'site-label',x:0,y:-52,'text-anchor':'middle'},nodeSite(node)));
      group.append(icon);
      const label = nodeName(node); group.append(svg('text', { x: -47, y: -7, class: 'node-title' }, label.length > 21 ? label.slice(0,20) + '…' : label));
      const subtitle = plain(nodeSub(node)); group.append(svg('text', { x: -47, y: 9, class: 'node-subtitle' }, subtitle.length > 25 ? subtitle.slice(0,24) + '…' : subtitle));
      group.append(svg('circle', { class: `node-status ${statusClass(node.status)}`, cx: 116, cy: -39, r: 3.5 }));
      if(node._officeConnections) group.append(svg('text',{x:-86,y:31,class:'node-connection-count'},`${node._officeConnections.members} узлов · ${node._officeConnections.summaries} наблюдений`));
      const vmCount = children(node.id, 'vm').length;
      const typeY = 50;
      if (node.kind === 'unknown') group.append(svg('rect', { class:'unknown-type-badge', x: -90, y: typeY-10, width: 139, height: 15, rx: 4 }));
      const typeLabel = vmCount && node.kind !== 'vm' ? `${TYPES[node.kind]} · ${vmCount} ВМ` : nodeTypeLabel(node);
      if (typeLabel !== subtitle) group.append(svg('text', { x: -86, y: typeY, class: 'node-subtitle' }, typeLabel));
      group.append(svg('title', {}, `${label}\n${subtitle}\n${statusLabel(node.status)}`));
      group.addEventListener('pointerdown', ev => startNodeDrag(ev, node));
      group.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(node.id); $('inspector').querySelector('.detail-close')?.focus(); } });
      nodeRoot.append(group); state.nodeElements.set(node.id,group);
    }
    applyTransform();
    if (refit || !state.fitted) scheduleFit();
  }
  function prepareEdgeGeometry() {
    const pairs=new Map(); state.incidentEdges=new Map(); state.edgeOffsets=new Map();
    for(const edge of state.visibleEdges) {
      const key=JSON.stringify([edge.source,edge.target].sort());
      if(!pairs.has(key)) pairs.set(key,[]); pairs.get(key).push(edge);
      for(const id of new Set([edge.source,edge.target])) {if(!state.incidentEdges.has(id))state.incidentEdges.set(id,[]);state.incidentEdges.get(id).push(edge);}
    }
    for(const pair of pairs.values()) {pair.sort((a,b)=>collator.compare(a.id,b.id));pair.forEach((edge,lane)=>state.edgeOffsets.set(edge.id,(lane-(pair.length-1)/2)*(edge.kind==='tunnel'?52:15)));}
    state.edgeGeometryEdges=state.visibleEdges;state.edgeGeometryCount=state.visibleEdges.length;
    state.edgeExtent=Math.max(0,...state.visible.map(node=>Math.abs(state.positions[node.id]?.x || 0)))+185;
  }
  function updateDraggedNode(id) {
    state.nodeElements.get(id)?.setAttribute('transform',`translate(${state.positions[id].x},${state.positions[id].y})`);
    if(elkEnabled()) {
      // ELK recomputes obstacle-aware routes on drop; a temporary stretched
      // segment must not be mistaken for an actual connection during dragging.
      for(const edge of state.incidentEdges.get(id) || []) state.edgeElements.get(edge.id)?.setAttribute('visibility','hidden');
      return;
    }
    // Outer rails depend on the farthest card. If that bound moves, update all rails;
    // ordinary moves touch only the incident edges.
    const extent=Math.max(0,...state.visible.map(node=>Math.abs(state.positions[node.id]?.x || 0)))+185;
    const changed=extent!==state.edgeExtent;state.edgeExtent=extent;
    for(const edge of changed?state.visibleEdges:(state.incidentEdges.get(id)||[])) edgeGeometry(state.edgeElements.get(edge.id),edge);
  }
  function edgeGeometry(group, edge) {
    const routed=elkEnabled() && state.elkGeometry?.routes?.[edge.id];
    if(routed) {
      const points=routed.points;
      group.querySelectorAll('.edge-path,.edge-hit').forEach(path=>path.setAttribute('d',points.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ')));
      group.querySelector('.edge-label').setAttribute('transform',`translate(${routed.label.x},${routed.label.y})`);
      for(const [index,p] of [points[0],points[points.length-1]].entries()) {
        let dot=group.querySelector(`.edge-endpoint-${index}`);
        if(!dot){dot=svg('circle',{class:`edge-endpoint edge-endpoint-${index}`,r:3});group.append(dot);}
        dot.setAttribute('cx',p.x);dot.setAttribute('cy',p.y);
      }
      return;
    }
    const a = state.positions[edge.source], b = state.positions[edge.target]; if (!a || !b) return;
    if (state.edgeGeometryEdges !== state.visibleEdges || state.edgeGeometryCount !== state.visibleEdges.length) prepareEdgeGeometry();
    const offset = state.edgeOffsets.get(edge.id) || 0;
    let d, lx, ly;
    if (Math.abs(a.y-b.y) >= 40) {
      const upper=a.y<b.y?a:b, lower=a.y<b.y?b:a;
      const start=upper.y+74, end=lower.y-54;
      if(lower.y-upper.y>300){
        // Links to a later row travel outside the switch cards, never behind
        // an unrelated sibling that happens to occupy the intermediate row.
        const side=lower.x<upper.x?-1:1;
        const extent=state.edgeExtent;
        const rail=side*extent+offset, shelf=end-38+offset;
        d=`M${upper.x+offset},${start} V${start+24} H${rail} V${shelf} H${lower.x+offset} V${end}`;
        lx=(rail+lower.x+offset)/2;ly=shelf-9;
      }else{
        const middle=(start+end)/2+offset;
        d=`M${upper.x+offset},${start} V${middle} H${lower.x+offset} V${end}`;
        lx=(upper.x+lower.x)/2+offset;ly=middle-9;
      }
    } else if (Math.abs(a.y-b.y) < 40) {
      const direction = a.x < b.x ? 1 : -1;
      const cardHalf = 130;
      const ax = a.x + cardHalf*direction, bx = b.x - cardHalf*direction;
      const ay = a.y+offset, by = b.y+offset, middle = (ax+bx)/2;
      d = `M${ax},${ay} H${middle} V${by} H${bx}`;
      lx = middle; ly = (ay+by)/2-9;
    } else {
      const direction = a.y < b.y ? 1 : -1;
      const ax = a.x+offset, bx = b.x+offset, ay = a.y+(direction>0?74:-54), by = b.y-(direction>0?54:-74);
      const middle = (ay+by)/2;
      d = `M${ax},${ay} C${ax},${middle} ${bx},${middle} ${bx},${by}`;
      lx = (ax+bx)/2; ly = middle-7 + offset;
    }
    group.querySelectorAll('path').forEach(p => p.setAttribute('d', d));
    group.querySelector('.edge-label').setAttribute('transform', `translate(${lx},${ly})`);
  }
  function showEdgeTooltip(edge, ev) {
    if (edge._officeGroup) { $('graph-tooltip').textContent='Группа подключений · раскрыть';$('graph-tooltip').hidden=false;moveTooltip(ev);return; }
    const a = state.nodes.get(edge.source), b = state.nodes.get(edge.target);
    if (vmPlacement(edge)) {
      $('graph-tooltip').textContent = `${b?.name || edge.target}\nХост ВМ · ${a?.name || edge.source}\nNetBox`;
      $('graph-tooltip').hidden = false;
      moveTooltip(ev);
      return;
    }
    const registered = edge.details?.relationship?.authority === 'netbox';
    const latest = registered ? [...(edge.details.relationship.observations || [])].filter(o=>o.observed_at).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0] : null;
    const timestamp = registered && edge.status==='documented' ? (latest ? latest.protocol+' · '+date(latest.observed_at) : '') : edge.last_seen ? (edge.status==='documented'?edge.last_seen:date(edge.last_seen)) : '';
    $('graph-tooltip').textContent = `${a?.name || edge.source} · ${edge.source_port || '—'}\n↔ ${b?.name || edge.target} · ${edge.target_port || '—'}\n${[edgeConfidenceLabel(edge),edgeStatusLabel(edge)].filter(Boolean).join(' · ')}\n${timestamp}`;
    $('graph-tooltip').hidden = false; moveTooltip(ev);
  }
  function moveTooltip(ev) {
    const rect = $('graph-wrap').getBoundingClientRect(), tip = $('graph-tooltip');
    tip.style.left = Math.max(8, Math.min(ev.clientX-rect.left+14, rect.width-tip.offsetWidth-10)) + 'px';
    tip.style.top = Math.max(8, Math.min(ev.clientY-rect.top+14, rect.height-tip.offsetHeight-10)) + 'px';
  }
  function applyTransform() { const t = state.transform; $('viewport').setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`); $('zoom-value').textContent = `${Math.round(t.k*100)}%`; }
  function scheduleFit() {
    const scope = state.scope, snapshot = state.data;
    requestAnimationFrame(() => { if (state.scope === scope && state.data === snapshot) fit(); });
  }
  function fit(ids) {
    if (!state.data || state.view !== 'topology' || !state.visible.length) return;
    const list = state.visible.filter(n => (!ids || ids.has(n.id)) && Number.isFinite(state.positions[n.id]?.x) && Number.isFinite(state.positions[n.id]?.y));
    if (!list.length) return;
    const rect = $('graph-wrap').getBoundingClientRect(); if (!rect.width || !rect.height) return;
    // Fitting already uses the current canvas. A queued resize must not apply
    // the old size delta to these freshly fitted coordinates a second time.
    clearTimeout(resizeTimer);previousCanvasSize={width:rect.width,height:rect.height};
    const xs = list.map(n => state.positions[n.id].x), ys = list.map(n => state.positions[n.id].y);
    const margin = 160;
    const left = Math.min(...xs)-margin, right = Math.max(...xs)+margin, top = Math.min(...ys)-85, bottom = Math.max(...ys)+105;
    const sharedInset = document.querySelector?.('.pl-ui-shell') ? 79 + ($('map-header')?.getBoundingClientRect().height || 42) + 80 : 0;
    const availableHeight = Math.max(100, rect.height-sharedInset);
    const k = Math.max(.12, Math.min(1.4, (rect.width-48)/(right-left), (availableHeight-55)/(bottom-top)));
    state.transform = { k, x: (rect.width-(left+right)*k)/2, y: sharedInset+(availableHeight-(top+bottom)*k)/2 };
    state.fitted = true; applyTransform();
  }
  function zoom(factor, x, y) {
    const rect = $('graph-wrap').getBoundingClientRect(), t = state.transform;
    x ??= rect.width/2; y ??= rect.height/2;
    const k = Math.max(.12,Math.min(3,t.k*factor));
    state.transform = { k, x: x-(x-t.x)*k/t.k, y: y-(y-t.y)*k/t.k }; applyTransform();
  }
  function startNodeDrag(ev, node) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    pointer = { kind: 'node', id: node.id, x: ev.clientX, y: ev.clientY, ox: state.positions[node.id].x, oy: state.positions[node.id].y, moved: false, pointerId: ev.pointerId };
    $('graph').setPointerCapture(ev.pointerId); $('graph').classList.add('is-dragging');
  }
  function expandOfficeGroup(id) {
    state.officeExpanded.add(id);state.selected=null;state.selectedEdge=null;
    renderGraph(true);renderInspector();
  }
  function officeOverview() {
    state.officeExpanded.clear();state.officeObservationQuery='';state.focus=null;state.branchRoot=null;state.selected=null;state.selectedRack=null;state.selectedEdge=null;resetContextFilters();
    $('graph-tooltip').hidden=true;
    renderGraph(true);renderRack();renderInspector();
  }
  function selectNode(id, fromRack = false) {
    if(groupedScope() && Office) {
      const group = state.officeProjection?.nodes.find(n=>n.id===id)?._officeGroup;
      if(group) { if(group.owner) selectNode(group.owner); else expandOfficeGroup(group.id); return; }
      if(Office.isNetwork(state.nodes.get(id) || {})) {state.officeObservationQuery=state.query;state.focus={mode:'neighbors',id};resetContextFilters();}
    }
    state.selected = String(id); state.selectedEdge = null;
    if (!fromRack) state.selectedRack = null;
    renderGraph(groupedScope()); renderRack(); renderInspector();
  }
  function showView(view, user = true) {
    if (view === 'rack' && !rackScope()) view = 'topology';
    state.view = view; if (user) state.viewChosen = true;
    for (const name of ['rack','topology']) { $(`${name}-view`).hidden = name !== view; $(`tab-${name}`).setAttribute('aria-selected', String(name === view)); }
    if (view === 'topology' && !state.fitted) scheduleFit();
  }
  function renderRack() {
    if (!state.data) return;
    const root = $('rack-content'); root.replaceChildren();
    const rack = state.data.site?.rack, height = Number(rack?.height_u);
    $('rack-view-title').textContent = rack?.name || 'Размещение в стойке';
    if (!Number.isInteger(height) || height < 1 || height > 60) {
      const box = element('div', { class: 'rack-unknown-box' }); box.append(element('span', { class: 'inspect-symbol' }, '▥'), element('strong', {}, 'Размещение в стойке не указано')); root.append(box);
    } else {
      for (const face of ['front','rear']) {
        const panel = element('div', { class: 'rack-face' });
        const heading = element('div', { class: 'rack-face-heading' }); heading.append(element('strong', {}, face === 'front' ? 'Передняя сторона' : 'Задняя сторона'), element('span', {}, `${height} U`)); panel.append(heading);
        const frame = element('div', { class: 'rack-frame', style: `height:${height*24}px;box-sizing:content-box`, 'aria-label': `${face === 'front' ? 'Передняя' : 'Задняя'} сторона стойки, ${height} юнитов` });
        for (let u=1;u<=height;u++) { const line = element('div', { class: 'rack-u', style: `bottom:${(u-1)*24}px;height:24px` }); line.append(element('span', {}, u)); frame.append(line); }
        for (const item of state.data.rack_items.filter(i => (i.face || 'front') === face)) {
          const position = Number(item.position), units = Number(item.height_u);
          if (!Number.isInteger(position) || !Number.isInteger(units) || units < 1 || position < 1 || position+units-1 > height) continue;
          const node = state.nodes.get(item.node_id), confirmed = item.identity_status === 'confirmed' && node;
          const filtered = state.query && ![item.label,node?.name,node?.management_ip].filter(Boolean).join(' ').toLowerCase().includes(state.query) || node && !state.kinds.has(node.kind);
          const identityLabel = rackIdentityLabel(item, node);
          const title = `${item.label || 'Оборудование'} · U${position}${units>1 ? '–'+(position+units-1) : ''} · ${identityLabel}`;
          const button = element('button', { class: `rack-device ${confirmed ? 'confirmed' : 'unresolved'} ${units===1 ? 'one-u' : ''} ${state.selectedRack===item.id || node && state.selected===node.id ? 'selected' : ''} ${filtered ? 'filter-dimmed' : ''}`, style: `bottom:${(position-1)*24+1}px;height:${units*24-2}px`, title, 'aria-label': title, 'data-rack':item.id });
          button.append(element('span', { class: `identity-dot ${confirmed ? 'confirmed' : ''}` }), element('strong', {}, item.label || 'Оборудование'), element('span', { class: 'rack-device-sub' }, identityLabel));
          button.addEventListener('click', () => { state.selectedRack = item.id; state.selectedEdge = null; state.selected = node?.id || null; renderRack(); renderGraph(); renderInspector(); }); frame.append(button);
        }
        panel.append(frame); root.append(panel);
      }
    }
    const unplaced = state.data.nodes.filter(n => !['vm','vswitch'].includes(n.kind) && !confirmedRackPlacement(n.id) && matches(n));
    const unplacedRoot = $('unplaced'); unplacedRoot.replaceChildren();
    unplacedRoot.append(element('h3', {}, `Без позиции в стойке · ${unplaced.length}`));
    const list = element('div', { class: 'unplaced-list' });
    for (const node of unplaced) { const button = element('button', {}, node.kind === 'unknown' ? plain(nodeSub(node)) : node.name); button.addEventListener('click', () => selectNode(node.id)); list.append(button); }
    unplacedRoot.append(list);
  }
  function section(title) { const e = element('section', { class: 'detail-section' }); e.append(element('h3', {}, title)); return e; }
  function row(label, value) { const e = element('div', { class: 'detail-row' }); e.append(element('dt', {}, label), element('dd', {}, plain(value))); return e; }
  function closeInspector() {
    const target = state.selectedRack ? ['rack',state.selectedRack] : state.selectedEdge ? ['edge',state.selectedEdge] : ['node',state.selected];
    state.selected = null; state.selectedRack = null; state.selectedEdge = null;
    if (state.data) { renderGraph(); renderRack(); renderInspector(); }
    if (target[1]) [...document.querySelectorAll(`[data-${target[0]}]`)].find(item => item.dataset[target[0]] === target[1])?.focus();
  }
  function detailHeader(kicker, title, status, statusText) {
    const header = element('div', { class: 'detail-header' });
    const close = element('button', { class: 'detail-close', 'aria-label': 'Закрыть сведения' }, '×');
    close.addEventListener('click', closeInspector);
    header.append(close, element('p', { class: 'detail-kicker' }, kicker), element('h2', {}, title));
    if (status) { const label = element('span', { class: 'status-label' }); label.append(dot(status), document.createTextNode(statusText || statusLabel(status))); header.append(label); }
    return header;
  }
  function action(label, callback, primary = false) { const b = element('button', { class: `button ${primary ? 'primary' : ''}` }, label); b.addEventListener('click', callback); return b; }
  function resetContextFilters() {
    cancelFilterRender();state.query = '';state.kinds=defaultKinds();state.allDevices=false;state.showObservations=true;
    $('search').value = '';syncTypeControls();
  }
  function revealContext(focus, selectedId, branchRoot = null) {
    resetContextFilters();
    state.focus = focus; state.branchRoot = branchRoot;
    state.selected = selectedId; state.selectedEdge = null;
    const selectedSlot = state.data?.rack_items?.find(item => item.id === state.selectedRack);
    if (selectedSlot && selectedSlot.node_id !== selectedId) state.selectedRack = null;
    showView('topology'); renderGraph(); renderRack(); renderInspector();
    const scope = state.scope, snapshot = state.data;
    requestAnimationFrame(() => {
      if (state.scope !== scope || state.data !== snapshot) return;
      fit();
      $('topology-view').scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  function openGraphForNode(id) {
    revealContext({mode:'neighbors',id},id);
  }
  function openVMGroup(rootId, selectedId = rootId) { revealContext({ mode: 'subtree', id: rootId }, selectedId, rootId); }
  function positionInspector() {
    const root=$('inspector');
    if(state.view!=='topology'){root.style.removeProperty('top');root.style.removeProperty('max-height');return;}
    const top=Math.max(16,$('general-plan').getBoundingClientRect().bottom+12);
    root.style.top=`${top}px`;root.style.maxHeight=`calc(100dvh - ${top+16}px)`;
  }
  function renderInspector() {
    const root = $('inspector');
    const node = state.nodes.get(state.selected), rackItem = state.data?.rack_items.find(i => i.id === state.selectedRack), edge = state.data && displayData().edges.find(e => e.id === state.selectedEdge);
    root.classList.toggle('has-selection', Boolean(node || rackItem || edge));
    if (!node && !rackItem && !edge) { root.innerHTML = emptyInspector; return; }
    requestAnimationFrame(positionInspector);
    root.replaceChildren();
    if (edge) {
      if (vmPlacement(edge)) {
        root.append(detailHeader('Размещение ВМ', 'Хост виртуальной машины'));
        const placement = section('Привязка в NetBox');
        for (const [label, id] of [['Хост ВМ', edge.source], ['Виртуальная машина', edge.target]]) {
          const asset = state.nodes.get(id);
          placement.append(row(label, asset?.name || id));
          if (asset) placement.append(action('Открыть ' + asset.name, () => selectNode(id)));
        }
        root.append(placement);
        return;
      }
      root.append(detailHeader('Соединение', 'Данные связи', edge.status, edgeStatusLabel(edge)));
      const info = section('Конечные точки');
      for (const [label,id,port] of [['A',edge.source,edge.source_port],['B',edge.target,edge.target_port]]) {
        const target = state.nodes.get(id); info.append(row(`Устройство ${label}`,target?.name || id));
        if(port || edge.kind!=='observed')info.append(row(`Порт ${label}`,port || 'Не определён'));
        for(const fact of portFacts(target,port))info.append(row(`Порт ${label} · состояние`,fact));
        if (edge.kind === 'tunnel') for (const [name,value] of tunnelEndpointRows(edge,label === 'A' ? 'source' : 'target',label)) info.append(row(name,value));
        if(target) info.append(action('Открыть '+target.name,()=>selectNode(id)));
      }
      root.append(info);
      if (edge.kind === 'tunnel') {
        const d = edge.details || {}, tunnel = section('Туннель');
        if (d.protocol) tunnel.append(row('Протокол',d.protocol));
        if (typeof d.ipsec_configured === 'boolean') tunnel.append(row('IPsec в конфигурации',d.ipsec_configured ? 'Настроен' : 'Не обнаружен'));
        if (d.ipsec_health_verified === false) tunnel.append(row('Состояние IPsec SA','Не проверялось'));
        if (typeof d.nhrp_registered === 'boolean') tunnel.append(row('NHRP-регистрация',d.nhrp_registered ? 'Наблюдалась' : 'Не обнаружена'));
        if (d.one_sided) tunnel.append(element('p',{class:'detail-text'},'Данные получены только с одной стороны соединения.'));
        if (d.status_note && factualNote(d.status_note)) tunnel.append(element('p',{class:'detail-text'},plain(d.status_note)));
        if (tunnel.childElementCount > 1) root.append(tunnel);
      }
      const relationship=edge.details?.relationship;
      const evidence = section('Источники связи');
      evidence.append(row('Тип',edgeKindLabel(edge)),...(edgeConfidenceLabel(edge) ? [row('Основание',edgeConfidenceLabel(edge))] : []));
      if (relationship?.authority !== 'netbox') evidence.append(row(edge.status==='documented' ? (['tunnel','routed'].includes(edge.kind) ? 'Конфигурация' : 'Подтверждено оператором') : 'Наблюдалась',edge.status==='documented'?edge.last_seen:date(edge.last_seen)));
      if(edge.last_seen && edge.status!=='documented')evidence.append(row('Возраст наблюдения',observationAge(edge.last_seen)));
      if(relationship) {
        const authority={netbox:'NetBox · зарегистрированный кабель',observation:'Наблюдение коллектора',operator:'Подтверждение оператора',esxi_api:'ESXi API',wan_configuration:'Конфигурация WAN',routing_configuration:'Конфигурация маршрутизации'};
        const assurance={registered:'Зарегистрировано в NetBox',legacy_inferred:'Автоматическая запись NetBox',exact_lldp:'LLDP/CDP · точная пара портов',direction:'Наблюдаемое направление',report:'Запись источника',conflict:'Противоречивые наблюдения',documented:'Из конфигурации',explicit:'Подтверждено API'};
        evidence.append(row('Источник связи',authority[relationship.authority] || relationship.authority),row('Основание',assurance[relationship.assurance] || relationship.assurance));
        for(const observation of relationship.observations || []) evidence.append(row(observation.protocol+' · '+date(observation.observed_at),[observation.source,[observation.source_port,observation.target_port].filter(Boolean).join(' → '),edge.status==='stale' && Date.parse(observation.observed_at)<=Date.parse(edge.last_seen)?'Устарело':observation.status==='stale'?'Устарело':'',observationAge(observation.observed_at)].filter(Boolean).join(' · ')));
        if(relationship.conflicts?.length) evidence.append(element('p',{class:'connection-conflict'},'Есть расхождение с другой связью на этом порту. Зарегистрированный кабель сохранён.'));
      }
      if (edge.evidence.length) for(const item of edge.evidence.filter(factualNote)) evidence.append(element('p',{class:'detail-text'},plain(item)));
      root.append(evidence);
      const cableUrl=safeLink(edge.netbox_url);
      if(cableUrl) root.append(element('a',{class:'button',href:cableUrl,target:'_blank',rel:'noopener noreferrer'},edge.kind === 'tunnel' ? 'Туннель в NetBox ↗' : 'Кабель в NetBox ↗'));
      return;
    }
    root.append(detailHeader(node ? nodeTypeLabel(node) : 'Позиция в стойке', node ? nodeName(node) : rackItem.label || 'Оборудование', node?.kind === 'passive' ? null : node?.status));
    if(node?.details?.observation_methods) {
      const observed=section('Наблюдение сети'), details=node.details;
      observed.append(row('Источник',details.observation_source || details.source || 'Опрос сети'));
      const labels={dhcp:'DHCP',arp:'ARP',ndp:'NDP',fdb:'FDB',lldp:'LLDP',cdp:'CDP',wifi:'Wi-Fi'};
      observed.append(row('Способ',details.observation_methods.map(method=>labels[method] || method).join(', ')));
      observed.append(row('Состояние',({observed:'Ответ получен',reported:'Сообщено источником',stale:'Данные устарели'})[details.observation_state] || 'Неизвестно'));
      if(details.last_seen) observed.append(row('Последнее наблюдение',date(details.last_seen)));
      if(details.mac) observed.append(row('MAC',details.mac));
      if(details.identity_unconfirmed) observed.append(element('p',{class:'detail-text'},'Этот IP также есть в NetBox. Здесь показана запись наблюдения.'));
      for(const report of details.reports || []) {
        observed.append(row('Источник',report.source));
        observed.append(row('Данные источника',(report.methods || []).map(method=>labels[method] || method).join(', ')));
        if(report.hostname) observed.append(row('Имя от источника',report.hostname));
        if(report.address) observed.append(row('IP от источника',report.address));
        if(report.mac) observed.append(row('MAC от источника',report.mac));
        if(report.observed_at) observed.append(row('Прочитано из источника',date(report.observed_at)));
        if(report.expires_at) observed.append(row('Срок записи',date(report.expires_at)));
      }
      root.append(observed);
    }
    if(node?.addressChecks?.length) {
      const checked = section('Проверка адресов');
      for (const check of node.addressChecks) {
        const methods = check.methods.map(method => method.toUpperCase().replace(':', ' ')).join(', ');
        const result = check.state === 'observed' ? 'Ответ получен' : 'Последний ответ устарел';
        checked.append(row(check.ip, [result, methods, date(check.last_seen)].filter(Boolean).join(' · ')));
      }
      root.append(checked);
    }
    if(node?.details?.direct_poll) {
      const availability=section('Доступность и путь'),poll=node.details.direct_poll;
      availability.append(row('Прямой опрос',poll.polling_enabled===false?'Отключён':{ok:'Доступ подтверждён',stale:'Нет свежих данных',error:'Ошибка опроса',unknown:'Не подключён'}[poll.status] || poll.status));
      if(poll.prerequisite)availability.append(row(poll.polling_enabled===false?'Причина':'Для подключения',poll.prerequisite));
      if(poll.last_success)availability.append(row('Успешный опрос',date(poll.last_success)));
      if(poll.polling_enabled!==false && poll.last_attempt)availability.append(row('Последняя попытка',date(poll.last_attempt)));
      for(const e of displayData().edges.filter(e=>e.kind==='observed' && e.target===node.id)) {
        const owner=state.nodes.get(e.source),facts=portFacts(owner,e.source_port);
        availability.append(row(e.status==='stale'?'Последнее известное направление':'Наблюдаемое направление',`${owner?.name || e.source} · ${e.source_port || '—'}`));
        if(e.last_seen)availability.append(row('FDB-наблюдение',`${date(e.last_seen)} · ${observationAge(e.last_seen)}${e.status==='stale'?' · устарело':''}`));
        const portAt=owner?.details?.direct_poll?.last_success || owner?.last_seen;
        if(facts.length)availability.append(row('Порт коммутатора',(portAt?facts.slice(0,-1):facts).join(' · ')));
        if(portAt)availability.append(row('Снимок порта',facts.at(-1)));
      }
      root.append(availability);
    }
    if (rackItem || node) {
      const info = section('Идентификация');
      const identityHint=node?.details?.identity_hint;
      if(identityHint) {
        if(identityHint.suggested_kind && node.kind==='unknown')info.append(row('Тип по источнику',TYPES[identityHint.suggested_kind] || identityHint.suggested_kind));
        if(identityHint.vendor)info.append(row('Производитель',identityHint.vendor));
        for(const item of identityHint.identity_evidence || [])info.append(row('Источник типа',
          [item.protocol,item.source,item.value,item.observed_at ? date(item.observed_at) : ''].filter(Boolean).join(' · ')));
      }
      if (rackItem) { info.append(row('Модель / запись',rackItem.label),row(rackItem.identity_status === 'tentative' ? 'Позиция по схеме' : 'Позиция',`U${rackItem.position}${rackItem.height_u>1 ? '–'+(rackItem.position+rackItem.height_u-1) : ''}`),row('Сторона',rackItem.face === 'rear' ? 'Задняя' : 'Передняя')); }
      if (node) {
        if (nodeSite(node)) info.append(row('Площадка',nodeSite(node)));
        if (node.kind === 'unknown') info.append(row('Обнаружено', nodeSub(node)));

        const hardware = { ...node.details, ...(node.details.hardware || {}) };
        for (const [key,label] of [['manufacturer','Производитель'],['model','Модель'],['serial','Серийный №'],['serial_number','Серийный №'],['os','ОС'],['software_version','Версия'],['mac','MAC']]) if(hardware[key] && factualNote(hardware[key])) info.append(row(label,hardware[key]));
        if (hardware) {
          if (hardware.firmware) info.append(row('Прошивка',hardware.firmware));
          if (hardware.provenance && factualNote(hardware.provenance)) info.append(row('Источник',hardware.provenance));
          if (hardware.access_verified_at) info.append(row('Доступ подтверждён',date(hardware.access_verified_at)));
          if (hardware.snapshot_observed_at) info.append(row('Снимок портов',date(hardware.snapshot_observed_at)));
          if (hardware.management_prefix) info.append(row('Управление',`${hardware.management_prefix} · VLAN ${hardware.management_vlan} · шлюз ${hardware.gateway}`));
          if (hardware.camera_fdb) info.append(row('Камеры в FDB',`${hardware.camera_fdb.uplink_count} за uplink; локальных ${hardware.camera_fdb.local_count} · ${date(hardware.camera_fdb.observed_at)}`));
          else if (Number.isInteger(hardware.known_camera_macs_via_uplink)) info.append(row('Камеры в FDB · снимок',`${hardware.known_camera_macs_via_uplink} через uplink 8; локальных нет`));
          if (hardware.observed_at) info.append(row(node.details.direct_poll ? 'Идентификация' : 'Снимок',date(hardware.observed_at)));
          if (hardware.vlan) info.append(row('VLAN интерфейса',hardware.vlan));
          if (hardware.previous_ip) info.append(row('Прежний IP',hardware.previous_ip));
          for (const vlan of hardware.vlans || []) info.append(row(`VLAN ${vlan.vlan} · ${vlan.interface}`,vlan.address));
          for (const observation of hardware.fdb || []) info.append(row(`FDB · ${date(observation.observed_at)}`,`${observation.port} · VLAN ${observation.vlan}`));
        }
        if (node.details.snapshot_lldp_observed_at && node.details.snapshot_lldp) {
          const peer=node.details.snapshot_lldp;
          info.append(row('LLDP · снимок',date(node.details.snapshot_lldp_observed_at)),
            row('LLDP имя',peer.system_name || peer.chassis_id),row('LLDP port ID',peer.port_id));
          if (peer.capabilities_enabled) info.append(row('LLDP capabilities',peer.capabilities_enabled));
        }
        if (node.details.runtime_observed_at) info.append(row('Наблюдение в сети',date(node.details.runtime_observed_at)));
        if (node.details.guest_os) info.append(row('Гостевая ОС',node.details.guest_os));
        if (node.details.product) info.append(row('Гипервизор',node.details.product));
        if (node.details.power_state) info.append(row('Питание',{poweredOn:'Включена',poweredOff:'Выключена',suspended:'Приостановлена'}[node.details.power_state] || node.details.power_state));
        if (Number.isFinite(node.details.vcpus)) info.append(row('vCPU',node.details.vcpus));
        if (Number.isFinite(hardware.cpu_cores)) info.append(row('Ядра CPU',hardware.cpu_cores));
        if (Number.isFinite(hardware.cpu_logical)) info.append(row('Потоки CPU',hardware.cpu_logical));
        if (Number.isFinite(hardware.memory_mib)) info.append(row('Оперативная память',`${Number((hardware.memory_mib/1024).toFixed(2)).toLocaleString('ru-RU')} ГиБ`));
        if (Array.isArray(node.details.macs) && node.details.macs.length) info.append(row('MAC-адреса',node.details.macs.join(', ')));
        if (Array.isArray(node.details.observed_ips) && node.details.observed_ips.length) info.append(row('Наблюдаемые IP',node.details.observed_ips.join(', ')));
        if (node.details.note && factualNote(node.details.note)) info.append(element('p',{class:'detail-text'},node.details.note));
        const confirmedPlacement = confirmedRackPlacement(node.id);
        const placement = rackItem || confirmedPlacement?.item;
        if (confirmedPlacement?.member) {
          info.append(row('Размещение',`${confirmedPlacement.item.face === 'rear' ? 'Задняя' : 'Передняя'} полка U${confirmedPlacement.item.position}`));
        }
        const parent = state.nodes.get(node.parent_id);
        if (parent) info.append(row(node.details.netbox_vm_id && parent.details?.netbox_id ? 'Хост ВМ' : 'Родитель', parent.name));
      }
      root.append(info);
    }
    if (Array.isArray(node?.details?.identities) && node.details.identities.length) {
      const identities = node.details.identities, info = section(`Имена из источников · ${identities.length}`);
      const sourceNames = {'dns-ptr':'DNS PTR','dns-zone':'DNS-зона','monitoring-target':'Мониторинг',lldp:'LLDP'};
      for (const identity of identities.slice(0,50)) {
        const item = element('div',{class:'link-item'});
        item.append(element('strong',{},identity.name || 'Имя не передано'));
        if (identity.ip) item.append(element('small',{},identity.ip));
        if (identity.mac) item.append(element('small',{},`MAC · ${identity.mac}`));
        const confidence = identityConfidence(identity);
        if (confidence) item.append(element('small',{},confidence));
        const hardware = [identity.vendor,identity.model].filter(Boolean).join(' · ');
        if (hardware) item.append(element('small',{},hardware));
        item.append(element('small',{},`${sourceNames[identity.source] || identity.source || 'Источник не указан'} · ${identity.observed_at ? date(identity.observed_at) : 'Время не передано'}`));
        info.append(item);
      }
      if (identities.length > 50) info.append(element('p',{class:'detail-more'},`Показано 50 из ${identities.length} записей. Все имена доступны в поиске.`));
      root.append(info);
    }
    if (node?.details?.lldp) {
      const peer = node.details.lldp, info = section('Данные LLDP-соседа');
      if (node.details.lldp_observed_at) info.append(row('Наблюдение',date(node.details.lldp_observed_at)));
      for (const [label,value] of [['Имя',peer.remote_system_name],['Описание системы',peer.remote_system_description || peer.remote_description],['Порт соседа',peer.remote_port_id || peer.remote_port],['Описание порта',peer.remote_port_description],['IP управления',peer.remote_management_ip],['Chassis ID',peer.remote_chassis_id]]) if (value) info.append(row(label,value));
      root.append(info);
    }
    const containerItem = rackItem || (node && confirmedRackPlacement(node.id)?.item);
    if (containerItem && (!node || containerItem.node_id === node.id)) {
      const members = (containerItem.member_node_ids || []).map(id => state.nodes.get(id)).filter(Boolean);
      if (members.length) {
        const shelf = section('На полке');
        for (const member of members) {
          const entry = element('div',{class:'link-item'});
          const button = element('button',{},member.name || nodeName(member));
          button.addEventListener('click',()=>openGraphForNode(member.id));
          entry.append(button,element('small',{},[member.management_ip,TYPES[member.kind]].filter(Boolean).join(' · ')));
          shelf.append(entry);
        }
        root.append(shelf);
      }
    }
    if (!node) return;
    if (node.kind !== 'passive') {
      const addresses = nodeAddresses(node), info = section(`IP-адреса · ${addresses.length}`);
      if (!addresses.length) info.append(element('p',{class:'detail-text'},'Нет адресов.'));
      for (const address of addresses) {
        const item = element('div',{class:'address-item'});
        item.append(element('strong',{},address.address || address.ip), element('span',{class:'address-role'},addressRole(address.role) + (address.primary && address.role !== 'primary' ? ' · основной' : '')));
        if (address.interface) item.append(element('small',{},address.interface));
        if (address.link_local) item.append(element('small',{},'Link-local · только в локальном сегменте'));
        info.append(item);
      }
      if (node.kind === 'switch' && node.uplink_ports?.length) info.append(row('Uplink-порты',node.uplink_ports.join(', ')));
      root.append(info);
    }
    if (groupedScope() && Office && Office.isNetwork(node)) {
      const adjacent = new Set(state.data.edges.filter(e=>e.source===node.id || e.target===node.id).map(e=>e.source===node.id?e.target:e.source));
      const observations=state.data.nodes.filter(n=>adjacent.has(n.id) && Office.isSummary(n));
      if(observations.length) {
        const observationsSection=section('Наблюдения по портам');
        for(const observation of observations) {
          const box=element('details',{class:'observation-details'}), rows=observation.details?.arp;
          box.append(element('summary',{},rows ? `ARP · ${rows.length} записей` : `${observation.details?.switch_port || observation.name} · ${(observation.details?.macs || []).length} MAC`));
          if(rows) {
            const query=state.query || state.officeObservationQuery;
            const filtered=query ? rows.filter(r=>plain(r).toLowerCase().includes(query)) : rows;
            if(query && filtered.length)box.open=true;
            for(const item of filtered.slice(0,200))box.append(element('p',{class:'detail-text'},[item.ip,item.mac,item.interface].filter(Boolean).join(' · ')));
            if(filtered.length>200)box.append(element('p',{class:'detail-more'},`Первые 200 из ${filtered.length}`));
          } else {
            box.append(element('p',{class:'detail-text'},(observation.details?.macs || []).join(', ')));
            if(observation.details?.observed_ips?.length)box.append(element('p',{class:'detail-text'},observation.details.observed_ips.join(', ')));
          }
          observationsSection.append(box);
        }
        root.append(observationsSection);
      }
    }
    const actions = section('Действия'), buttons = element('div',{class:'detail-actions'});
    if(groupedScope() && Office?.isNetwork(node)) buttons.append(action('Раскрыть все подключения',()=>{state.focus=null;state.selected=null;expandOfficeGroup('ui:clients:'+node.id);},false));
    if (node.kind !== 'passive') buttons.append(action('Показать связи',()=>openGraphForNode(node.id),true));
    const targetScope = node.details?.netmap_scope;
    if (targetScope && targetScope !== state.scope && scopeDefinitions.has(targetScope)) buttons.append(action('Открыть ' + SCOPES[targetScope],()=>changeScope(targetScope,'topology'),true));
    const configUrl = safeLink(node.config_url);
    if (configUrl) buttons.append(element('a',{class:'button',href:configUrl,target:'_blank',rel:'noopener noreferrer'},'Конфигурация · Oxidized ↗'));
    const historyUrl = safeLink(node.config_history_url);
    if (historyUrl) buttons.append(element('a',{class:'button',href:historyUrl,target:'_blank',rel:'noopener noreferrer'},'История · Gitea ↗'));
    const url = safeLink(node.netbox_url); if(url) buttons.append(element('a',{class:'button',href:url,target:'_blank',rel:'noopener noreferrer'},'Открыть NetBox ↗'));
    const vmId = node.details?.netbox_vm_id;
    if (node.kind === 'vm' && Number.isSafeInteger(vmId) && vmId > 0) {
      buttons.append(element('a',{class:'button',href:`/netmap/netbox/virtualization/virtual-machines/${vmId}/edit/`,target:'_blank',rel:'noopener noreferrer'},
        node.parent_id ? 'Изменить хост в NetBox ↗' : 'Назначить хост в NetBox ↗'));
    }
    const vms = children(node.id,'vm');
    if (vms.length) buttons.append(action(`Показать ВМ · ${vms.length}`,()=>openVMGroup(node.id)));
    if (buttons.childElementCount) { actions.append(buttons);root.append(actions); }
    if (node.config_status || node.last_config_update) {
      const config = section('Конфигурация');
      if (node.config_status) config.append(row('Состояние',STATUS[node.config_status] || plain(node.config_status)));
      if (node.last_config_update) config.append(row('Последний успешный сбор',date(node.last_config_update)));
      root.append(config);
    }
    const edges = displayData().edges.filter(e=>e.source===node.id||e.target===node.id);
    const links = section(`Соединения · ${edges.length}`), list = element('div',{class:'scroll-list'});
    if (!edges.length) links.append(element('p',{class:'no-edge-note'},'Связи не обнаружены.'));
    for (const e of edges) {
      const other = state.nodes.get(e.source===node.id?e.target:e.source), item=element('div',{class:'link-item'});
      const button=element('button',{},other?.name||'Неопознанная конечная точка'); button.addEventListener('click',()=>{if(other)selectNode(other.id);});
      item.append(button);
      if (vmPlacement(e)) item.append(element('small',{},'Размещение ВМ · NetBox'));
      else item.append(element('small',{},`${e.source===node.id?e.source_port||'—':e.target_port||'—'} ↔ ${e.source===node.id?e.target_port||'—':e.source_port||'—'}`),element('small',{},edgeSummary(e)));
      if(e.last_seen && e.status!=='documented')item.append(element('small',{},`${e.kind==='observed' && e.status==='stale'?'Последнее известное направление':'Наблюдение'}: ${date(e.last_seen)} · ${observationAge(e.last_seen)}`));
      const sourceNode=state.nodes.get(e.source),targetNode=state.nodes.get(e.target);
      for(const [owner,port] of [[sourceNode,e.source_port],[targetNode,e.target_port]])for(const fact of portFacts(owner,port))item.append(element('small',{},`${owner.name} · ${port}: ${fact}`));
      list.append(item);
    }
    if (node.kind !== 'passive') { links.append(list);root.append(links); }
    if(vms.length){const group=section(`Виртуальные машины · ${vms.length}`),items=element('div',{class:'scroll-list'});for(const vm of vms){const item=element('div',{class:'link-item'});const b=element('button',{},vm.name);b.addEventListener('click',()=>openVMGroup(node.id,vm.id));item.append(b,element('small',{},statusLabel(vm.status)));items.append(item);}group.append(items);root.append(group);}
    if(node.ports.length){const ports=section(`Порты · ${node.ports.length}`),table=element('table',{class:'ports-table'}),thead=element('thead'),head=element('tr');['Интерфейс','Статус','VLAN'].forEach(s=>head.append(element('th',{},s)));thead.append(head);table.append(thead);const body=element('tbody');for(const port of node.ports){const tr=element('tr');const portName=element('td',{},port.name);if(port.pvid!=null){portName.append(element('br'),element('small',{class:'muted'},[port.description,port.speed,`PVID ${port.pvid}`].filter(Boolean).join(' · ')));}tr.append(portName);const status=element('td');const effective=portStatus(port);status.append(dot(effective),document.createTextNode(effective==='up'?'Up':effective==='down'?'Down':'—'));if(typeof port.admin_up==='boolean')status.append(element('br'),element('small',{class:'muted'},port.admin_up?'Admin Up':'Admin Down'));tr.append(status,element('td',{},portVlanLabel(port)));body.append(tr);}table.append(body);ports.append(table);if(node.ports.length>12){const search=element('input',{type:'search',placeholder:'Найти порт', 'aria-label':'Найти порт'});search.addEventListener('input',()=>{const query=search.value.trim().toLowerCase();for(const tr of body.children)tr.hidden=!tr.textContent.toLowerCase().includes(query);});ports.insertBefore(search,table);}root.append(ports);}
  }
  function updateFilters() {
    cancelFilterRender();
    state.layoutGeneration=(state.layoutGeneration || 0)+1;
    if(!state.data)return;
    const scope=state.scope;
    filterTimer=setTimeout(()=>{
      filterTimer=null;
      if(scope!==state.scope || !state.data)return;
      renderGraph(true);renderRack();renderInspector();
    },140);
  }
  async function changeScope(scope, view = null) {
    if (!Object.hasOwn(SCOPES, scope) || scope === state.scope || state.loading) return;
    cancelFilterRender();state.layoutGeneration=(state.layoutGeneration || 0)+1;
    state.scope = scope;
    state.data = null; state.visible = []; state.visibleEdges = []; pointer = null; cancelPendingPointer(); state.nodes = new Map(); state.selected = null; state.selectedRack = null; state.selectedEdge = null;
    state.lastPayload=null;state.officeExpanded.clear();state.officeObservationQuery='';state.officeProjection=null;state.officeLayoutContexts.clear();state.officeActiveContext=null;
    state.focus = null; state.branchRoot = null; state.positions = {}; state.pinned.clear(); state.fitted = false;
    state.query = '';state.kinds=defaultKinds();state.allDevices=false;state.showObservations=true;state.pathContext=null; state.viewChosen = Boolean(view); state.view = view || 'topology';
    $('search').value = '';syncTypeControls();$('path-summary').hidden=true;
    $('nodes').replaceChildren(); $('edges').replaceChildren(); $('inspector').innerHTML = emptyInspector;
    $('sources').replaceChildren(); $('source-count').textContent = ''; $('counts').textContent = 'Загрузка…';
    $('coverage').hidden = true; $('data-warnings').hidden = true; $('graph-tooltip').hidden = true;
    $('site-name').textContent = SCOPES[scope];
    $('tab-rack').hidden = !rackScope(); showView('topology', false);
    const url = new URL(location.href); url.searchParams.set('scope',scope); history.replaceState(null,'',url);
    await refresh();
  }
  $('layout-mode').addEventListener('change',ev=>{
    const layout = ev.target.value;
    if (!['graph','groups'].includes(layout) || layout === state.layout) return;
    state.layoutGeneration=(state.layoutGeneration || 0)+1;
    state.layout=layout;state.officeExpanded.clear();state.officeProjection=null;
    state.officeLayoutContexts.clear();state.officeActiveContext=null;state.elkGeometry=null;
    state.positions={};state.pinned.clear();state.fitted=false;state.showAllLinks=true;
    state.focus=null;state.branchRoot=null;state.selected=null;state.selectedRack=null;state.selectedEdge=null;
    resetContextFilters();
    const url=new URL(location.href);
    if(layout==='groups')url.searchParams.set('layout',layout);else url.searchParams.delete('layout');
    history.replaceState(null,'',url);
    if(state.data){renderGraph(true);renderInspector();}
  });
  $('search').addEventListener('input',ev=>{state.query=ev.target.value.trim().toLowerCase();state.focus=null;state.branchRoot=null;updateFilters();});
  $('kind-filters').addEventListener('change',ev=>{
    const kind=ev.target.dataset?.kind;if(!FILTER_KINDS.includes(kind))return;
    if(ev.target.checked)state.kinds.add(kind);else state.kinds.delete(kind);
    state.selected=null;state.selectedEdge=null;
    state.focus=null;state.branchRoot=null;updateFilters();
  });
  $('types-all').addEventListener('click',()=>{state.kinds=new Set(FILTER_KINDS);state.allDevices=true;state.showObservations=false;state.selected=null;state.selectedEdge=null;syncTypeControls();state.focus=null;state.branchRoot=null;updateFilters();});
  $('show-all-links')?.addEventListener('change',ev=>{state.showAllLinks=ev.target.checked;state.fitted=false;updateFilters();});
  $('show-observations').addEventListener('change',ev=>{state.showObservations=ev.target.checked;state.focus=null;state.branchRoot=null;state.selected=null;state.selectedEdge=null;updateFilters();});
  $('types-none').addEventListener('click',()=>{state.kinds.clear();state.allDevices=false;state.showObservations=false;syncTypeControls();state.focus=null;state.branchRoot=null;updateFilters();});
  $('clear-filters').addEventListener('click',()=>{resetContextFilters();state.branchRoot=null;state.focus=null;updateFilters();});
  $('general-plan').addEventListener('click',officeOverview);
  $('office-overview').addEventListener('click',officeOverview);
  $('office-collapse').addEventListener('click',officeOverview);
  $('show-all').addEventListener('click',()=>{if(groupedScope()){officeOverview();return;}state.focus=null;state.branchRoot=null;state.selected=null;state.selectedEdge=null;renderGraph(true);renderInspector();});
  $('tab-rack').addEventListener('click',()=>showView('rack'));
  $('tab-topology').addEventListener('click',()=>showView('topology'));
  $('refresh').addEventListener('click',refresh);
  $('zoom-in').addEventListener('click',()=>zoom(1.2));$('zoom-out').addEventListener('click',()=>zoom(1/1.2));$('fit').addEventListener('click',()=>fit());
  $('reset-layout').addEventListener('click',()=>{state.positions={};state.pinned.clear();state.elkGeometry=null;try{localStorage.removeItem(elkStorageKey());}catch{}if(state.data){renderGraph(true);savePositions();}});
  $('graph').addEventListener('wheel',ev=>{if(!ev.ctrlKey && !ev.metaKey)return;ev.preventDefault();const rect=$('graph-wrap').getBoundingClientRect();zoom(Math.exp(-ev.deltaY*.001),ev.clientX-rect.left,ev.clientY-rect.top);},{passive:false});
  $('graph').addEventListener('pointerdown',ev=>{if(ev.button!==0||ev.target.closest('.node')||ev.target.closest('.edge'))return;pointer={kind:'pan',x:ev.clientX,y:ev.clientY,ox:state.transform.x,oy:state.transform.y,moved:false,pointerId:ev.pointerId};$('graph').setPointerCapture(ev.pointerId);$('graph').classList.add('is-dragging');});
  let pointerFrame=null;
  function applyPointerMove(ev){if(!pointer||ev.pointerId!==pointer.pointerId)return;const dx=ev.clientX-pointer.x,dy=ev.clientY-pointer.y;if(Math.abs(dx)+Math.abs(dy)>4)pointer.moved=true;if(pointer.kind==='pan'){state.transform.x=pointer.ox+dx;state.transform.y=pointer.oy+dy;applyTransform();}else{state.positions[pointer.id]={x:pointer.ox+dx/state.transform.k,y:pointer.oy+dy/state.transform.k};updateDraggedNode(pointer.id);}}
  $('graph').addEventListener('pointermove',ev=>{if(!pointer||ev.pointerId!==pointer.pointerId)return;state.pendingPointer={pointerId:ev.pointerId,clientX:ev.clientX,clientY:ev.clientY};if(pointerFrame===null)pointerFrame=requestAnimationFrame(()=>{pointerFrame=null;const last=state.pendingPointer;state.pendingPointer=null;if(last)applyPointerMove(last);});});
  function cancelPendingPointer(){state.pendingPointer=null;if(pointerFrame!==null){cancelAnimationFrame(pointerFrame);pointerFrame=null;}}
  function stopPointer(ev) {
    if(!pointer || ev.pointerId!==pointer.pointerId)return;
    if(state.pendingPointer){applyPointerMove(state.pendingPointer);state.pendingPointer=null;}
    if(pointerFrame!==null){cancelAnimationFrame(pointerFrame);pointerFrame=null;}
    const old=pointer;pointer=null;
    $('graph').classList.remove('is-dragging');
    if($('graph').hasPointerCapture(ev.pointerId))$('graph').releasePointerCapture(ev.pointerId);
    if(old.kind==='node') {
      if(old.moved) {
        if(elkEnabled()){const refit=Boolean(state.pendingElkRefit);state.pendingElkRefit=false;renderGraph(refit,true);}
        else {state.pinned.add(old.id);savePositions();}
      } else selectNode(old.id);
    } else if(!old.moved) {
      state.selected=null;state.selectedEdge=null;state.selectedRack=null;
      renderGraph();renderRack();renderInspector();
    }
  }
  $('graph').addEventListener('pointerup',stopPointer);$('graph').addEventListener('pointercancel',ev=>{cancelPendingPointer();pointer=null;$('graph').classList.remove('is-dragging');if(elkEnabled())renderGraph();});
  document.addEventListener('keydown',ev=>{if(ev.key==='/'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)){ev.preventDefault();$('search').focus();}if(ev.key==='Escape'){if(state.selected || state.selectedEdge || state.selectedRack) closeInspector();else setContextPanel(null,true);$('graph-tooltip').hidden=true;}});
  // The source list scrolls independently; the SVG fills the workspace's right
  // column. A resize keeps the user's scale and the point at the canvas centre.
  let resizeTimer, previousCanvasSize = null;
  function resizeCanvas(width, height) {
    if (width <= 0 || height <= 0 || state.view !== 'topology') return;
    if (!state.fitted) fit();
    else if (previousCanvasSize) {
      state.transform.x += (width - previousCanvasSize.width) / 2;
      state.transform.y += (height - previousCanvasSize.height) / 2;
      applyTransform();
    }
    if(state.selected || state.selectedEdge || state.selectedRack)positionInspector();
    previousCanvasSize = {width,height};
  }
  document.addEventListener('scroll',()=>{if(state.selected || state.selectedEdge || state.selectedRack)requestAnimationFrame(positionInspector);},true);
  new ResizeObserver(entries => {
    clearTimeout(resizeTimer);
    const {width,height} = entries[0].contentRect;
    resizeTimer = setTimeout(() => resizeCanvas(width,height),100);
  }).observe($('graph-wrap'));
  // Overlay height can change when the search and controls wrap in a narrow window.
  new ResizeObserver(entries => {
    document.querySelector('.workspace').style.setProperty('--map-header-height',`${entries[0].contentRect.height}px`);
  }).observe($('map-header'));
  let mapInteracted = false;
  $('graph-wrap').addEventListener('pointerdown',()=>{mapInteracted=true;},{once:true});
  $('graph-wrap').addEventListener('wheel',()=>{mapInteracted=true;},{once:true,passive:true});
  document.addEventListener('pl-ui-map-shell-ready',()=>{if(!mapInteracted)scheduleFit();},{once:true});
  let activeContextPanel = null, sidebarCollapsed = false;
  function setContextPanel(name, returnFocus = false) {
    const previous = activeContextPanel;
    activeContextPanel = ['filters','legend','sources'].includes(name) ? name : null;
    if(activeContextPanel)$('map-status').open=false;
    $('context-panel').hidden = !activeContextPanel;
    for (const panel of ['filters','legend','sources']) {
      $(`panel-${panel}`).hidden = panel !== activeContextPanel;
      $(`context-${panel}`).setAttribute('aria-expanded',String(panel === activeContextPanel));
    }
    if (!activeContextPanel && returnFocus && previous) $(`context-${previous}`).focus();
    return activeContextPanel;
  }
  function toggleContextPanel(name) { return setContextPanel(activeContextPanel === name ? null : name); }
  $('map-status').addEventListener('toggle',()=>{if($('map-status').open)setContextPanel(null);});
  document.addEventListener('click',event=>{if($('map-status').open&&!event.target.closest('#map-status'))$('map-status').open=false;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')$('map-status').open=false;});
  function setSidebarCollapsed(collapsed) {
    sidebarCollapsed = Boolean(collapsed);
    $('app-shell').classList.toggle('sidebar-collapsed',sidebarCollapsed);
    $('sidebar-toggle').setAttribute('aria-expanded',String(!sidebarCollapsed));
    $('sidebar-toggle').setAttribute('aria-label',sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню');
    try { localStorage.setItem('pl-ui-topology-sidebar-collapsed',String(sidebarCollapsed)); } catch {}
    return sidebarCollapsed;
  }
  function syncNavigation() {
    document.querySelectorAll('[data-scope]').forEach(link => {
      link.toggleAttribute('aria-current', link.dataset.scope === state.scope);
      if (link.dataset.scope === state.scope) link.setAttribute('aria-current','page');
    });
  }
  document.querySelectorAll('[data-scope]').forEach(link => link.addEventListener('click',event => {
    event.preventDefault(); changeScope(link.dataset.scope).then(syncNavigation);
  }));
  syncNavigation();
  $('demo-banner').hidden=!demo;
  const navigation = document.getElementById('scope-navigation');
  navigation.replaceChildren(...config.scopes.map(scope => {
    const link = element('a', {href:'?scope=' + encodeURIComponent(scope.id), 'data-scope':scope.id, title:scope.name, 'aria-label':scope.name});
    const icon = svg('svg', {viewBox:'0 0 24 24', 'aria-hidden':'true'});
    icon.append(svg('path', {d:'M12 7v5M5 17v-5h14v5'}), svg('rect', {x:8,y:2,width:8,height:5,rx:1}), svg('rect', {x:1,y:17,width:8,height:5,rx:1}), svg('rect', {x:15,y:17,width:8,height:5,rx:1}));
    link.append(icon, element('span', {}, scope.name));
    link.addEventListener('click', event => { event.preventDefault(); changeScope(scope.id).then(syncNavigation); });
    return link;
  }));
  document.getElementById('platform-link').href = config.platform_url || '/';
  syncNavigation();
  document.querySelectorAll('[data-context]').forEach(button => button.addEventListener('click',() => toggleContextPanel(button.dataset.context)));
  $('context-close').addEventListener('click',() => setContextPanel(null,true));
  $('sidebar-toggle').addEventListener('click',() => setSidebarCollapsed(!sidebarCollapsed));
  try { setSidebarCollapsed(localStorage.getItem('pl-ui-topology-sidebar-collapsed') === 'true'); } catch {}
  $('expand-map').addEventListener('click',() => document.querySelector('.workspace').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}));
  refresh();setInterval(()=>{if(!document.hidden)refresh();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})();

// Enhance the map with the Platform shell after its shared assets load. The
// existing map remains usable when those assets are unavailable.
(() => {
  'use strict';
  const style=document.createElement('link');style.rel='stylesheet';style.href='/ecosystem/ui-v1.css';
  const script=document.createElement('script');script.src='/ecosystem/ui-v1.js';
  const loaded=element=>new Promise((resolve,reject)=>{
    let timer;
    const finish=()=>{
      let ready=element!==style;
      if(element===style){try{ready=Boolean(style.sheet?.cssRules.length);}catch{ready=false;}}
      clearTimeout(timer);element.removeEventListener('load',finish);element.removeEventListener('error',fail);
      ready?resolve():reject(new Error('Shared stylesheet unavailable'));
    };
    const fail=()=>{clearTimeout(timer);element.removeEventListener('load',finish);element.removeEventListener('error',fail);reject(new Error('Shared asset unavailable'));};
    element.addEventListener('load',finish,{once:true});element.addEventListener('error',fail,{once:true});timer=setTimeout(fail,8000);
    if(element===style)document.head.insertBefore(element,document.querySelector('link[href="./style.css"]'));
    else document.head.appendChild(element);
  });
  Promise.all([loaded(style),loaded(script)]).then(() => {
    const source=document.getElementById('app-shell');
    const aside=source?.querySelector('#sidebar');
    const navs=aside?.querySelectorAll('nav.sidebar-nav');
    const workspace=source?.querySelector('main .workspace');
    if(!source||!navs?.length||!workspace||!window.PLUI?.createShell)return;
    const shared=window.PLUI.createShell({
      branding:{name:'PL',subtitle:'PLATFORM',label:'Platform'},context:'Инфраструктура',navigationId:'sidebar',wide:true,
      onLogout:async()=>{
        const response=await fetch('/api/v1/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(8000)});
        if(response.status===401){location.assign('/');return;}
        if(!response.ok)throw new Error('session unavailable');
        const session=await response.json();
        if(!session.authenticated){location.assign('/');return;}
        if(!session.csrf_token)throw new Error('missing csrf');
        const result=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':session.csrf_token},signal:AbortSignal.timeout(8000)});
        if(!result.ok&&result.status!==401)throw new Error('logout failed');
        location.assign('/');
      }
    });
    shared.element.id='app-shell';
    shared.slots.navigation.classList.add('sidebar-nav');
    shared.slots.navigation.setAttribute('aria-label','Разделы инфраструктуры');
    for(const [index,nav] of Array.from(navs).entries()){
      if(index){const divider=document.createElement('div');divider.className='divider';shared.slots.navigation.appendChild(divider);}
      shared.slots.navigation.append(...Array.from(nav.childNodes));
    }
    const footer=aside.querySelector('.sidebar-footer');
    if(footer)shared.slots.sidebarFooter.appendChild(footer);
    const oldTheme=document.getElementById('theme-toggle');
    if(typeof oldTheme?._plThemeUnmount==='function')oldTheme._plThemeUnmount();
    oldTheme?.remove();
    shared.slots.main.appendChild(workspace);
    source.replaceWith(shared.element);
    document.dispatchEvent(new Event('pl-ui-map-shell-ready'));
    fetch('/api/v1/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(8000)}).then(response=>response.ok?response.json():null).then(session=>{
      if(!session?.authenticated)return;
      shared.setUser({name:session.user?.name || session.user?.id || '',subtitle:'Пользователь Платформы'});
      shared.setLogoutDisabled(false);
    }).catch(()=>{});
  }).catch(()=>{style.remove();script.remove();});
})();
