import { Button } from '@pl/ui/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, appBase } from '../api/client';
import type { DepartmentListItem, DepartmentReport, PathSample, ScanProgress, ScanRun } from '../types/audit';
import type { BranchSimulation, DepartmentRemediation } from '../types/stage5';
import { departmentAction, dateTime, number, percent, plural, type Finding, type Findings, type Instance } from './shared';
import { usePlatformSession } from './session';

const get = async <T,>(path: string, params?: Record<string, string | number>) => (await api.get<T>(path, { params })).data;

function useLatest() {
  return useQuery({ queryKey: ['scan-latest'], queryFn: async () => (await get<ScanRun[]>('/scans', { take: 1, completedOnly: 'true' }))[0] || null, retry: 1 });
}

function useDepartments() {
  return useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentListItem[]>('/departments'), retry: 1 });
}

function Intro({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-intro"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="page-action">{action}</div>}</div>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'warning' }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}

function QueryFailure({ retry, label = 'Не удалось получить данные сервиса.' }: { retry: () => void; label?: string }) {
  return <section className="panel pl-panel"><Notice tone="error">{label}</Notice><Button variant="secondary" onClick={retry}>Повторить запрос</Button></section>;
}

function Severity({ value }: { value: string | null }) {
  const key = (value || 'unknown').toLowerCase();
  const label = key === 'critical' ? 'Критично' : key === 'bad' ? 'Проблема' : key === 'warning' ? 'Внимание' : key === 'ok' ? 'В норме' : 'Не определено';
  return <span className={`severity ${key}`}>{label}</span>;
}

export function OverviewPage() {
  const latest = useLatest();
  const departments = useDepartments();
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => get<Instance>('/instance'), retry: 1 });
  const rows = useMemo(() => (departments.data || [])
    .filter(item => item.department.criticalPaths > 0)
    .sort((a, b) => b.department.criticalPaths - a.department.criticalPaths), [departments.data]);
  const scan = latest.data;

  return <>
    <Intro title="Обзор структуры" action={<Link className="pl-button pl-button-secondary" to="/scans">Сканирования →</Link>}/>
    {(latest.isError || departments.isError || instance.isError) && <QueryFailure retry={() => { void latest.refetch(); void departments.refetch(); void instance.refetch(); }} label="Данные обзора недоступны."/>}
    {latest.isLoading && <section className="panel pl-panel loading-panel">Загружаем последний срез…</section>}
    {!latest.isLoading && !scan && !latest.isError && <section className="panel pl-panel empty-state"><h2>Срез ещё не создан</h2><Link to="/scans" className="pl-button pl-button-default">Открыть сканирования</Link></section>}
    {scan && <>
      <div className="snapshot-line"><span className="snapshot-badge">Срез №{scan.id}</span><span>{scan.status === 'Completed' ? 'Завершён' : scan.status}</span><span>{dateTime(scan.finishedAtUtc || scan.startedAtUtc)}</span>{scan.errorCount > 0 && <span className="snapshot-warning">Ошибок обхода: {number.format(scan.errorCount)}</span>}</div>
      {instance.data?.latestCompletedRootNames?.length ? <p className="coverage-line">Области среза: {instance.data.latestCompletedRootNames.join(' · ')}</p> : null}
      <section className="summary-grid" aria-label="Показатели последнего среза">
        <article className="panel pl-panel summary-card"><span>Документы и папки</span><strong>{number.format(scan.totalObjects)}</strong></article>
        <article className="panel pl-panel summary-card"><span>Длинные пути</span><strong>{number.format(scan.criticalPaths + scan.badPaths)}</strong><small>Критичные и проблемные · {percent(scan.criticalPaths + scan.badPaths, scan.totalObjects)}</small></article>
        <article className="panel pl-panel summary-card"><span>Критичные пути</span><strong className="danger-text">{number.format(scan.criticalPaths)}</strong></article>
      </section>
      <section className="overview-work">
        <div className="section-head"><h2>Разделы с критичными путями</h2><Link to="/departments">Все подразделения →</Link></div>
        {departments.isLoading && <div className="panel pl-panel loading-panel">Загружаем подразделения…</div>}
        {rows.length === 0 && !departments.isLoading && !departments.isError && <div className="panel pl-panel empty-state">Критичных путей нет.</div>}
        <div className="work-grid">{rows.slice(0, 3).map(({ department }, index) => { const task = departmentAction(department); return <article className="panel pl-panel work-card" key={department.id}><div className="work-card-top"><span className="work-index">{index + 1}</span><Severity value={department.criticalPaths > 0 ? 'Critical' : 'Warning'}/></div><h3>{department.departmentName}</h3><p className="work-root">{department.rootLabel}</p><strong className="task-title">{task.title}</strong><p>{task.detail}</p><div className="work-card-foot"><span>{number.format(department.criticalPaths)} критичных путей</span><Link to={`/departments/${department.id}`}>Открыть разбор →</Link></div></article>; })}</div>
      </section>
      <section className="panel pl-panel next-step-panel"><h2>Документы с длинными путями</h2><Link className="pl-button pl-button-default" to="/documents">Открыть примеры</Link></section>
    </>}
  </>;
}

export function DepartmentsPage() {
  const departments = useDepartments();
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<'critical' | 'problems' | 'name'>('critical');
  const [onlyCritical, setOnlyCritical] = useState(false);
  const rows = useMemo(() => (departments.data || []).filter(({ department }) => {
    const match = `${department.departmentName} ${department.rootLabel}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'));
    return match && (!onlyCritical || department.criticalPaths > 0);
  }).sort((a, b) => order === 'name' ? a.department.departmentName.localeCompare(b.department.departmentName, 'ru') : order === 'problems' ? b.department.problemObjects - a.department.problemObjects : b.department.criticalPaths - a.department.criticalPaths), [departments.data, search, order, onlyCritical]);

  return <>
    <Intro title="Подразделения и папки"/>
    <div className="filter-bar"><label>Найти раздел<input className="pl-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Название или корень"/></label><label>Сортировка<select className="pl-select" value={order} onChange={event => setOrder(event.target.value as typeof order)}><option value="critical">Сначала критичные</option><option value="problems">Сначала все проблемы</option><option value="name">По названию</option></select></label><label className="check-filter"><input type="checkbox" checked={onlyCritical} onChange={event => setOnlyCritical(event.target.checked)}/> Только критичные</label></div>
    {departments.isError && <QueryFailure retry={() => void departments.refetch()}/>}
    {departments.isLoading && <section className="panel pl-panel loading-panel">Загружаем подразделения…</section>}
    {!departments.isLoading && !departments.isError && <section className="panel pl-panel table-panel"><div className="section-head compact"><h2>Разделы с проблемами</h2><span>{number.format(rows.length)} из {number.format(departments.data?.length || 0)}</span></div>{rows.length === 0 ? <div className="empty-state">По выбранным фильтрам разделов нет.</div> : <div className="table-wrap"><table><thead><tr><th>Раздел</th><th>Критичные пути</th><th>Все проблемы</th><th>Доля проблем</th><th>Макс. путь</th><th>Что проверить</th></tr></thead><tbody>{rows.map(({ department }) => <tr key={department.id}><td><Link className="table-link" to={`/departments/${department.id}`}>{department.departmentName}</Link><small>{department.rootLabel}</small></td><td><strong>{number.format(department.criticalPaths)}</strong></td><td>{number.format(department.problemObjects)}</td><td>{percent(department.problemObjects, department.totalObjects)}</td><td>{department.maxPathLength} симв.</td><td className="action-cell">{departmentAction(department).title}</td></tr>)}</tbody></table></div>}</section>}
  </>;
}

function SampleList({ title, samples }: { title: string; samples: PathSample[] }) {
  if (!samples.length) return null;
  return <div className="sample-group"><h3>{title}</h3><div className="sample-grid">{samples.slice(0, 6).map(sample => <article className="sample-item" key={sample.id}><div><Severity value={sample.severity}/><span>{sample.pathLength} симв. · глубина {sample.depth}</span></div><code>{sample.dfsPath || sample.uncPath || sample.relativePath}</code></article>)}</div></div>;
}

function BranchModel({ departmentId, data }: { departmentId: number; data: DepartmentRemediation }) {
  const exact = data.branches.filter(branch => branch.exactSimulationAvailable);
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);
  const [shortenBy, setShortenBy] = useState(30);
  const branchId = selectedBranchId !== null && exact.some(branch => branch.branchId === selectedBranchId)
    ? selectedBranchId : exact[0]?.branchId;
  const model = useQuery({
    queryKey: ['branch-model', departmentId, branchId, shortenBy],
    enabled: branchId !== undefined,
    queryFn: () => get<BranchSimulation>(`/intelligence/departments/${departmentId}/simulate`, { branchId: branchId!, shortenBy }),
    retry: false,
  });
  if (!exact.length) return <p className="data-note">Расчёт по веткам появится после нового среза.</p>;
  return <div className="branch-model">
    <div className="filter-bar"><label>Ветка<select className="pl-select" value={branchId} onChange={event => setSelectedBranchId(Number(event.target.value))}>{exact.map(branch => <option key={branch.branchId} value={branch.branchId}>{branch.relativePath}</option>)}</select></label><label>Сократить путь на<select className="pl-select" value={shortenBy} onChange={event => setShortenBy(Number(event.target.value))}><option value={10}>10 символов</option><option value={30}>30 символов</option><option value={50}>50 символов</option><option value={100}>100 символов</option></select></label></div>
    {model.isLoading && <p>Считаем эффект для ветки…</p>}
    {model.isError && <Notice tone="warning">Расчёт для этой ветки недоступен. Проверьте другой вариант или обновите срез.</Notice>}
    {model.data && <div className="model-result"><div><span>Критичных путей в ветке сейчас</span><strong>{number.format(model.data.before.critical)}</strong></div><div><span>После сокращения пути</span><strong>{number.format(model.data.after.critical)}</strong></div><div><span>Могут выйти из критичной зоны</span><strong>{number.format(model.data.criticalReduced)}</strong></div></div>}
  </div>;
}

export function DepartmentPage() {
  const { id } = useParams();
  const departmentId = Number(id);
  const report = useQuery({ queryKey: ['department-report', departmentId], enabled: Number.isSafeInteger(departmentId) && departmentId > 0, queryFn: () => get<DepartmentReport>(`/departments/${departmentId}`), retry: 1 });
  const intelligence = useQuery({ queryKey: ['department-intelligence', departmentId], enabled: Boolean(report.data), queryFn: () => get<DepartmentRemediation>(`/intelligence/departments/${departmentId}`), retry: 1 });
  const [technical, setTechnical] = useState(false);
  if (!Number.isSafeInteger(departmentId) || departmentId <= 0) return <section className="panel pl-panel empty-state"><h2>Раздел не найден</h2><Link to="/departments" className="pl-button pl-button-secondary">Все подразделения</Link></section>;
  if (report.isLoading) return <section className="panel pl-panel loading-panel">Загружаем разбор подразделения…</section>;
  if (report.isError || !report.data) return <QueryFailure retry={() => void report.refetch()} label="Отчёт подразделения недоступен или не найден."/>;
  const data = report.data;
  const department = data.department;
  const task = departmentAction(department);
  const primary = data.branches[0];

  return <>
    <div className="back-row"><Link to="/departments">← Все подразделения</Link><button type="button" className="pl-button pl-button-secondary" onClick={() => window.print()}>Печать / PDF</button></div>
    <Intro eyebrow={`${department.rootLabel} · СРЕЗ №${data.scanId}`} title={department.departmentName}/>
    <section className="panel pl-panel task-hero"><div><span className="section-kicker">РЕКОМЕНДУЕМОЕ ДЕЙСТВИЕ</span><h2>{task.title}</h2><p>{task.detail}</p>{primary && <p className="task-path">Первая ветка для проверки: <code>{primary.relativePath}</code></p>}</div><div className="task-hero-stat"><strong>{number.format(department.criticalPaths)}</strong><span>критичных путей</span><small>{percent(department.criticalPaths, department.totalObjects)} объектов раздела</small></div></section>
    <div className="detail-metrics"><div className="panel pl-panel"><span>Всего объектов</span><strong>{number.format(department.totalObjects)}</strong></div><div className="panel pl-panel"><span>Проблемные</span><strong>{number.format(department.problemObjects)}</strong><small>{percent(department.problemObjects, department.totalObjects)}</small></div><div className="panel pl-panel"><span>Длиннейший путь</span><strong>{department.maxPathLength}</strong><small>символов</small></div><div className="panel pl-panel"><span>Глубина</span><strong>{department.maxDepth}</strong><small>уровней</small></div></div>
    <section className="panel pl-panel branch-panel"><div className="section-head"><div><span className="section-kicker">ГДЕ ПРОВЕРЯТЬ</span><h2>Ветки с наибольшим числом проблем</h2></div></div>{data.branches.length === 0 ? <div className="empty-state">Ветки не найдены.</div> : <div className="table-wrap"><table><thead><tr><th>Ветка</th><th>Критичные</th><th>Проблемные</th><th>Макс. путь</th></tr></thead><tbody>{data.branches.slice(0, 12).map(branch => <tr key={branch.id}><td><code className="path-code">{branch.relativePath}</code></td><td><strong>{number.format(branch.criticalPaths)}</strong></td><td>{number.format(branch.problemObjects)}</td><td>{branch.maxPathLength} симв.</td></tr>)}</tbody></table></div>}</section>
    <section className="panel pl-panel evidence-panel"><div className="section-head"><div><span className="section-kicker">ПРИМЕРЫ</span><h2>Конкретные пути для согласования</h2></div><Link to={`/documents?department=${encodeURIComponent(department.departmentKey)}`}>Все примеры →</Link></div><SampleList title="Самые длинные пути" samples={data.longestPaths}/><SampleList title="Самые глубокие папки" samples={data.deepestPaths}/><SampleList title="Длинные имена" samples={data.longNames}/></section>
    {intelligence.data && <section className="panel pl-panel"><div className="section-head"><div><span className="section-kicker">РАСЧЁТ</span><h2>Эффект сокращения пути</h2></div></div><BranchModel departmentId={departmentId} data={intelligence.data}/></section>}
    <section className="panel pl-panel technical-panel"><button type="button" className="disclosure-button" aria-expanded={technical} onClick={() => setTechnical(!technical)}>{technical ? 'Скрыть показатели' : 'Дополнительные показатели'}</button>{technical && <div className="technical-content"><dl><div><dt>Оценка структуры</dt><dd>{department.hygieneScore}/100</dd></div><div><dt>Предупреждения</dt><dd>{number.format(department.warningPaths)}</dd></div><div><dt>Проблемные пути</dt><dd>{number.format(department.badPaths)}</dd></div><div><dt>Длинные имена</dt><dd>{number.format(department.longNames)}</dd></div><div><dt>Глубокие пути</dt><dd>{number.format(department.deepPaths)}</dd></div></dl></div>}</section>
  </>;
}

function FindingDetail({ finding, thresholds, onClose }: { finding: Finding; thresholds: Findings['thresholds']; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') || []);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  const path = finding.dfsPath || finding.uncPath || finding.relativePath;
  const categories = findingCategories(finding, thresholds);
  async function copy() {
    try { await navigator.clipboard.writeText(path); setCopied(true); } catch { setCopied(false); }
  }
  return <div className="finding-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="finding-detail" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="finding-title"><div className="finding-detail-header"><div><span className="section-kicker">КАРТОЧКА ДОКУМЕНТА</span><h2 id="finding-title">{findingName(finding)}</h2></div><button ref={closeButton} type="button" className="pl-button pl-button-secondary" onClick={onClose} aria-label="Закрыть карточку">Закрыть</button></div><dl className="finding-facts">{categories.length > 0 && <div><dt>Категория проблемы</dt><dd>{categories.join(' · ')}</dd></div>}<div><dt>Тип примера</dt><dd>{findingKind(finding.sampleKind)}</dd></div><div><dt>Оценка длины пути</dt><dd><Severity value={finding.severity}/></dd></div><div><dt>Раздел</dt><dd>{finding.departmentName}</dd></div><div><dt>Длина пути</dt><dd>{finding.pathLength} символов</dd></div><div><dt>Глубина</dt><dd>{finding.depth} уровней</dd></div><div><dt>Длина имени</dt><dd>{finding.nameLength} символов</dd></div></dl><div className="finding-path-block"><h3>Полный путь</h3><code>{path}</code></div>{finding.uncPath && finding.uncPath !== path && <div className="finding-path-block secondary"><h3>Путь на сервере</h3><code>{finding.uncPath}</code></div>}<div className="finding-actions"><button className="pl-button pl-button-default" type="button" onClick={copy}>{copied ? 'Путь скопирован' : 'Скопировать путь'}</button>{finding.departmentId && <Link to={`/departments/${finding.departmentId}`}>Открыть раздел →</Link>}</div></div></div>;
}

function findingCategories(finding: Finding, thresholds: Findings['thresholds']) {
  const cause = findingCause(finding.cause);
  if (thresholds) {
    const categories = [];
    if (finding.pathLength > thresholds.warningPathLength) categories.push('Длинный путь');
    if (finding.depth > thresholds.maxDepth) categories.push('Глубокая вложенность');
    if (finding.nameLength > thresholds.longNameLength) categories.push('Длинное имя');
    return categories.length ? categories : cause ? [cause] : [];
  }
  if (cause) return [cause];
  return ['CRITICAL', 'BAD', 'WARNING'].includes(finding.severity?.toUpperCase() || '') ? ['Длинный путь'] : [];
}

function findingCause(cause: string | null) {
  switch (cause?.toUpperCase()) {
    case 'LONG_PARENT': case 'LONGPARENT': return 'Длинный путь к папке';
    case 'DEEP_TREE': case 'DEEPTREE': return 'Глубокая вложенность';
    case 'LONG_NAME': case 'LONGNAME': return 'Длинное имя';
    case 'MIXED': return 'Сочетание причин';
    default: return null;
  }
}

function findingKind(kind: string) {
  return kind === 'Longest' ? 'Длинный путь' : kind === 'Deepest' ? 'Глубокая папка' : kind === 'LongName' ? 'Длинное имя' : kind;
}

function findingName(finding: Finding) {
  return finding.name?.trim() || finding.relativePath.split(/[\\/]/).filter(Boolean).at(-1) || finding.departmentName;
}

export function DocumentsPage() {
  const departments = useDepartments();
  const [params, setParams] = useSearchParams();
  const department = params.get('department') || '';
  const severity = params.get('severity') || '';
  const kind = params.get('kind') || '';
  const page = Math.max(1, Number(params.get('page') || 1) || 1);
  const [selected, setSelected] = useState<Finding | null>(null);
  const findings = useQuery({ queryKey: ['findings', department, severity, kind, page], queryFn: () => get<Findings>('/findings', { ...(department && { department }), ...(severity && { severity }), ...(kind && { kind }), page, pageSize: 30 }), retry: 1 });
  function update(key: string, value: string) { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('page'); setParams(next); setSelected(null); }
  function move(nextPage: number) { const next = new URLSearchParams(params); next.set('page', String(nextPage)); setParams(next); setSelected(null); }

  return <>
    <Intro title="Документы и пути"/>
    <div className="filter-bar"><label>Подразделение<select className="pl-select" value={department} onChange={event => update('department', event.target.value)}><option value="">Все разделы</option>{departments.data?.map(({ department: item }) => <option key={item.id} value={item.departmentKey}>{item.departmentName}</option>)}</select></label><label>Оценка длины пути<select className="pl-select" value={severity} onChange={event => update('severity', event.target.value)}><option value="">Все</option><option value="Critical">Критично</option><option value="Bad">Проблема</option><option value="Warning">Внимание</option></select></label><label>Тип примера<select className="pl-select" value={kind} onChange={event => update('kind', event.target.value)}><option value="">Все типы</option><option value="Longest">Длинный путь</option><option value="Deepest">Глубокая папка</option><option value="LongName">Длинное имя</option></select></label></div>
    {findings.isError && <QueryFailure retry={() => void findings.refetch()}/>}
    {findings.isLoading && <section className="panel pl-panel loading-panel">Загружаем примеры…</section>}
    {findings.data && <section className="panel pl-panel table-panel"><div className="section-head compact"><h2>Найденные примеры</h2><span>{number.format(findings.data.total)} · срез №{findings.data.scanId || '—'}</span></div>{findings.data.items.length === 0 ? <div className="empty-state">Для выбранных фильтров примеров нет.</div> : <div className="findings-list">{findings.data.items.map(item => <button type="button" key={item.id} className={`finding-row${selected?.id === item.id ? ' selected' : ''}`} aria-haspopup="dialog" onClick={() => setSelected(item)}><span><strong title={findingName(item)}>{findingName(item)}</strong><small>{item.departmentName} · {findingKind(item.sampleKind)}</small></span><code>{item.dfsPath || item.uncPath || item.relativePath}</code><span className="finding-row-end"><Severity value={item.severity}/><small>{item.pathLength} симв.</small></span></button>)}</div>}{selected && <FindingDetail key={selected.id} finding={selected} thresholds={findings.data.thresholds} onClose={() => setSelected(null)}/>}<div className="pagination"><button className="pl-button pl-button-secondary" disabled={page <= 1} onClick={() => move(page - 1)}>← Назад</button><span>Страница {page} из {Math.max(1, Math.ceil(findings.data.total / findings.data.pageSize))}</span><button className="pl-button pl-button-secondary" disabled={page * findings.data.pageSize >= findings.data.total} onClick={() => move(page + 1)}>Далее →</button></div></section>}
  </>;
}

function ScanDialog({ onClose, onConfirm, pending, roots }: { onClose: () => void; onConfirm: () => void; pending: boolean; roots: string[] }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(pending);
  useEffect(() => {
    onCloseRef.current = onClose;
    pendingRef.current = pending;
  }, [onClose, pending]);
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) onCloseRef.current();
      if (event.key === 'Tab') {
        const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.scan-dialog button:not(:disabled)'));
        if (items.length < 2) return;
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
        if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous.current?.focus(); };
  }, []);
  return <div className="dialog-overlay"><div className="scan-dialog pl-native-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-dialog-title"><span className="section-kicker">НОВЫЙ СРЕЗ</span><h2 id="scan-dialog-title">Запустить сканирование?</h2><div className="dialog-roots"><strong>Выбрано для среза: {roots.length} {plural(roots.length, 'область', 'области', 'областей')}</strong><span>{roots.join(' · ')}</span></div><div className="dialog-footer"><Button ref={cancel} variant="secondary" onClick={onClose} disabled={pending}>Отмена</Button><Button variant="default" onClick={onConfirm} disabled={pending}>{pending ? 'Запускаем…' : 'Запустить'}</Button></div></div></div>;
}

export function ScansPage() {
  const client = useQueryClient();
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => get<Instance>('/instance'), retry: 1 });
  const session = usePlatformSession();
  const canScan = !appBase || session.data?.user?.admin === true;
  const [selection, setSelection] = useState<{ machine: string; names: string[] } | null>(null);
  const machine = instance.data?.machineName || '';
  const availableNames = instance.data?.roots.map(root => root.name) || [];
  const rootSignature = availableNames.join('\u0000');
  const storedNames = useMemo(() => {
    if (!machine) return [];
    let saved: unknown;
    try { saved = JSON.parse(localStorage.getItem(`auditor-scan-roots:${machine}`) || 'null'); } catch { saved = null; }
    return Array.isArray(saved) && saved.every(item => typeof item === 'string')
      ? saved.filter(name => availableNames.includes(name)) : availableNames;
  // A refetch with the same root names must not reset a pending choice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, rootSignature]);
  const selectedRoots = selection?.machine === machine ? selection.names.filter(name => availableNames.includes(name)) : storedNames;
  function chooseRoots(names: string[]) {
    setSelection({ machine, names });
    try { localStorage.setItem(`auditor-scan-roots:${machine}`, JSON.stringify(names)); } catch { /* Browser storage is optional. */ }
  }
  const [confirm, setConfirm] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [pendingScanId, setPendingScanId] = useState<number | null>(null);
  const history = useQuery({ queryKey: ['scan-history'], queryFn: () => get<ScanRun[]>('/scans', { take: 30 }), refetchInterval: query => {
    if (pendingScanId === null) return false;
    const run = query.state.data?.find(item => item.id === pendingScanId);
    return run?.status === 'Completed' || run?.status === 'Failed' ? false : 1000;
  }, retry: 1 });
  const current = useQuery({ queryKey: ['scan-current'], queryFn: async () => { const response = await api.get<ScanProgress | null>('/scans/current'); return response.status === 204 || !response.data || typeof response.data !== 'object' ? null : response.data; }, refetchInterval: query => query.state.data ? 1000 : 15_000, retry: 1 });
  const start = useMutation({ mutationFn: () => api.post<{ scanId: number }>('/scans', { rootNames: selectedRoots }), onSuccess: async response => { setConfirm(false); setLaunchError(''); setPendingScanId(response.data.scanId); await Promise.all([client.invalidateQueries({ queryKey: ['scan-current'] }), client.invalidateQueries({ queryKey: ['scan-history'] })]); }, onError: () => setLaunchError('Не удалось запустить сканирование. Проверьте право запуска и состояние службы.') });
  const activeRun = current.data?.status === 'Running' ? current.data : null;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (activeRun) wasRunning.current = true;
    else if (wasRunning.current && !current.isLoading) {
      wasRunning.current = false;
      for (const key of ['scan-latest', 'scan-history', 'departments', 'instance', 'findings']) void client.invalidateQueries({ queryKey: [key] });
    }
  }, [activeRun, current.isLoading, client]);
  const pendingRun = pendingScanId === null ? null : history.data?.find(item => item.id === pendingScanId);
  const pendingRunFinished = pendingRun?.status === 'Completed' || pendingRun?.status === 'Failed';
  useEffect(() => {
    if (!pendingRunFinished) return;
    for (const key of ['scan-latest', 'scan-history', 'departments', 'instance', 'findings']) void client.invalidateQueries({ queryKey: [key] });
  }, [pendingRunFinished, client]);

  return <>
    <Intro title="Сканирования" action={<button className="pl-button pl-button-default" type="button" onClick={() => setConfirm(true)} disabled={!canScan || selectedRoots.length === 0 || Boolean(activeRun) || start.isPending || current.isError || current.isLoading || instance.isLoading || instance.isError}>{activeRun ? 'Сканирование идёт' : 'Новый срез'}</button>}/>
    {launchError && <Notice tone="error">{launchError}</Notice>}
    {current.isError && <Notice tone="error">Статус сканирования недоступен.</Notice>}
    {activeRun ? <section className="panel pl-panel scan-progress"><div><span className="live-dot"/><h2>Сканирование выполняется</h2><p>Запуск №{activeRun.scanId} · {dateTime(activeRun.startedAtUtc)}</p></div><div className="progress-metrics"><div><strong>{number.format(activeRun.processedObjects)}</strong><span>объектов обработано</span></div><div><strong>{number.format(activeRun.objectsPerSecond)}</strong><span>объектов/с</span></div><div><strong>{activeRun.activeWorkers}/{activeRun.totalWorkers}</strong><span>потоков</span></div></div></section> : current.isLoading && <section className="panel pl-panel loading-panel">Загружаем статус…</section>}
    <section className="panel pl-panel scan-settings"><div className="section-head"><h2>Что сканировать</h2><span>{selectedRoots.length} из {availableNames.length}</span></div>
      {instance.isLoading && <p>Загружаем список областей…</p>}
      {instance.isError && <Notice tone="error">Список областей недоступен.</Notice>}
      {instance.data && <><div className="root-choice-list">{instance.data.roots.map(root => <label className="root-choice" key={root.name}><input type="checkbox" checked={selectedRoots.includes(root.name)} disabled={!canScan || Boolean(activeRun)} onChange={event => chooseRoots(event.target.checked ? [...selectedRoots, root.name] : selectedRoots.filter(name => name !== root.name))}/><span><strong>{root.name}</strong><small>{root.dfsPath || root.serverUNC || root.localPath}</small></span></label>)}</div><div className="root-choice-actions"><button type="button" className="text-button" disabled={!canScan || Boolean(activeRun)} onClick={() => chooseRoots(availableNames)}>Выбрать все</button><button type="button" className="text-button" disabled={!canScan || Boolean(activeRun)} onClick={() => chooseRoots([])}>Снять выбор</button></div></>}
    </section>
    {history.isError && <QueryFailure retry={() => void history.refetch()} label="История сканирований недоступна."/>}
    {history.isLoading && <section className="panel pl-panel loading-panel">Загружаем историю…</section>}
    {history.data && <section className="panel pl-panel table-panel"><div className="section-head compact"><h2>История</h2></div>{history.data.length === 0 ? <div className="empty-state">Срезов пока нет.</div> : <div className="table-wrap"><table><thead><tr><th>Срез</th><th>Начало</th><th>Состояние</th><th>Объекты</th><th>Ошибки</th><th>Время обхода</th></tr></thead><tbody>{history.data.map(run => <tr key={run.id}><td><strong>№{run.id}</strong></td><td>{dateTime(run.startedAtUtc)}</td><td><span className={`status ${run.status.toLowerCase()}`}>{run.status === 'Completed' ? 'Завершён' : run.status === 'Failed' ? 'Ошибка' : run.status}</span></td><td>{number.format(run.totalObjects)}</td><td>{number.format(run.errorCount)}</td><td>{run.scannerDurationMs ? `${(run.scannerDurationMs / 1000).toFixed(2)} с` : '—'}</td></tr>)}</tbody></table></div>}</section>}
    {confirm && <ScanDialog onClose={() => setConfirm(false)} onConfirm={() => start.mutate()} pending={start.isPending} roots={selectedRoots}/>}
  </>;
}

export function ServicePage() {
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => get<Instance>('/instance'), retry: 1 });
  return <>
    <Intro title="О сервисе"/>
    {instance.isError && <QueryFailure retry={() => void instance.refetch()} label="Не удалось получить параметры экземпляра."/>}
    {instance.isLoading && <section className="panel pl-panel loading-panel">Загружаем параметры…</section>}
    {instance.data && <><section className="panel pl-panel service-identity"><span className="section-kicker">ТЕКУЩИЙ СЕРВЕР</span><h2>{instance.data.machineName}</h2>{instance.data.latestCompletedScanId && <p>Последний завершённый срез: №{instance.data.latestCompletedScanId} · {dateTime(instance.data.latestCompletedScanFinishedAtUtc)}</p>}{instance.data.latestCompletedRootNames?.length > 0 && <p>Области среза: {instance.data.latestCompletedRootNames.join(' · ')}</p>}</section><section className="panel pl-panel table-panel"><div className="section-head"><div><span className="section-kicker">ИСТОЧНИКИ</span><h2>Доступные для сканирования корни</h2></div><span>{instance.data.roots.length} областей</span></div><div className="table-wrap"><table><thead><tr><th>Раздел</th><th>Путь на сервере</th><th>Путь для пользователей</th></tr></thead><tbody>{instance.data.roots.map((root, index) => <tr key={`${root.name}:${index}`}><td><strong>{root.name}</strong></td><td><code>{root.localPath}</code></td><td><code>{root.dfsPath || root.serverUNC || root.localPath}</code></td></tr>)}</tbody></table></div></section><section className="panel pl-panel"><div className="section-head"><div><span className="section-kicker">ПРАВИЛА ОЦЕНКИ</span><h2>Пороговые значения</h2></div></div><div className="threshold-grid"><div><strong>{instance.data.thresholds.warningPathLength}</strong><span>Предупреждение, свыше</span></div><div><strong>{instance.data.thresholds.badPathLength}</strong><span>Проблема, свыше</span></div><div><strong>{instance.data.thresholds.criticalPathLength}</strong><span>Критично, свыше</span></div><div><strong>{instance.data.thresholds.longNameLength}</strong><span>Длинное имя, свыше</span></div><div><strong>{instance.data.thresholds.maxDepth}</strong><span>Глубина, свыше</span></div></div></section></>}
  </>;
}
