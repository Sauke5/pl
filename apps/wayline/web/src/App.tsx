import { FormEvent, useEffect, useRef, useState } from 'react'
import { mountThemeMenu } from './theme'
import { PlatformShell, Button } from '@pl/ui/react'
import { getPlatformSession, isPlatformIntegrated, logoutPlatformSession, PlatformAuthError, subscribeAuthFailure, waylineFetch } from './platform-auth'

const iconPaths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  route: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M6 9v5a4 4 0 0 0 4 4h5 M18 3v8 M14 7h8',
  speed: 'M4 18a9 9 0 1 1 16 0 M12 13l5-5 M8 20h8',
  target: 'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6 M8 12h8 M12 8v8',
  history: 'M3 11a9 9 0 1 1 2.5 7 M3 4v7h7 M12 7v5l3 2',
  plus: 'M12 5v14 M5 12h14',
  play: 'm8 5 11 7-11 7Z',
  back: 'm12 5-7 7 7 7 M5 12h14',
  logout: 'M9 4H4v16h5 M13 8l4 4-4 4 M8 12h13',
  close: 'm6 6 12 12 M18 6 6 18',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 1.5 1.5 M19 5l-1.5 1.5 M6.5 17.5 5 19',
  moon: 'M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z',
} as const

type IconName = keyof typeof iconPaths
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>
}

function PanelTitle({ icon, title, detail }: { icon: IconName; title: string; detail?: string }) {
  return <div className="panel-title"><h2><Icon name={icon} />{title}</h2>{detail && <p>{detail}</p>}</div>
}

function ThemeButton() {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (button.current) return mountThemeMenu(button.current)
  }, [])
  return <Button variant="ghost" size="icon" ref={button} className="icon-button header-icon-button" type="button" aria-label="Выбрать тему" title="Выбрать тему" />
}

type PathState = 'healthy' | 'warning' | 'down' | 'unknown'
type ProbeMode = 'mtr' | 'icmp' | 'tcp'

type Target = {
  id: number
  name: string
  host: string
  enabled: boolean
  probe_mode: ProbeMode
  probe_port: number
  interval_seconds: number
  packet_count: number
  loss_threshold_percent: number
  iperf_enabled: boolean
  iperf_host: string
  iperf_port: number
  iperf_duration_seconds: number
  created_at?: string
  updated_at?: string
}

type TargetDraft = Omit<Target, 'id' | 'created_at' | 'updated_at'>

const emptyTarget: TargetDraft = {
  name: '',
  host: '',
  enabled: true,
  probe_mode: 'mtr',
  probe_port: 0,
  interval_seconds: 60,
  packet_count: 10,
  loss_threshold_percent: 3,
  iperf_enabled: false,
  iperf_host: '',
  iperf_port: 0,
  iperf_duration_seconds: 0,
}

const modeLabels: Record<ProbeMode, string> = {
  mtr: 'MTR',
  icmp: 'ICMP',
  tcp: 'TCP',
}

const intervalLabels: Record<number, string> = {
  30: '30 секунд',
  60: '1 минута',
  300: '5 минут',
  600: '10 минут',
  900: '15 минут',
  1800: '30 минут',
  3600: '1 час',
}

type Hop = {
  hop_number: number
  host: string
  ip?: string
  loss_percent?: number
  packets_sent?: number
  last_ms?: number
  avg_ms?: number
  best_ms?: number
  worst_ms?: number
  stddev_ms?: number
}

type CheckRun = {
  id: number
  target_id: number
  kind: 'path' | 'iperf' | string
  status: 'success' | 'degraded' | 'failed' | string
  started_at: string
  finished_at: string
  duration_ms: number
  loss_percent?: number
  avg_latency_ms?: number
  jitter_ms?: number
  throughput_bps?: number
  direction?: 'download' | 'upload' | string
  error_message?: string
  hops: Hop[]
}

function StatusDot({ state }: { state: PathState }) {
  const labels: Record<PathState, string> = { healthy: 'доступно', warning: 'деградация', down: 'недоступно', unknown: 'нет данных' }
  return <span className={`status-dot status-${state}`} aria-label={labels[state]} />
}

function ConfigStatusDot({ enabled }: { enabled: boolean }) {
  return <span className={`status-dot status-${enabled ? 'healthy' : 'unknown'}`} aria-label={enabled ? 'активна' : 'выключена'} />
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseRuns(body: unknown): CheckRun[] {
  const source = Array.isArray(body) ? body : isRecord(body)
    ? (Array.isArray(body.checks) ? body.checks : Array.isArray(body.runs) ? body.runs : [])
    : []
  return source.filter(isRecord).map((run) => ({
    id: Number(run.id),
    target_id: Number(run.target_id),
    kind: typeof run.kind === 'string' ? run.kind : 'path',
    status: typeof run.status === 'string' ? run.status : 'failed',
    started_at: typeof run.started_at === 'string' ? run.started_at : '',
    finished_at: typeof run.finished_at === 'string' ? run.finished_at : '',
    duration_ms: Number(run.duration_ms) || 0,
    loss_percent: optionalNumber(run.loss_percent),
    avg_latency_ms: optionalNumber(run.avg_latency_ms),
    jitter_ms: optionalNumber(run.jitter_ms),
    throughput_bps: optionalNumber(run.throughput_bps),
    direction: typeof run.direction === 'string' ? run.direction : undefined,
    error_message: typeof run.error_message === 'string' ? run.error_message : undefined,
    hops: Array.isArray(run.hops) ? run.hops.filter(isRecord).map((hop) => ({
      hop_number: Number(hop.hop_number),
      host: typeof hop.host === 'string' ? hop.host : '*',
      ip: typeof hop.ip === 'string' ? hop.ip : undefined,
      loss_percent: optionalNumber(hop.loss_percent),
      packets_sent: optionalNumber(hop.packets_sent),
      last_ms: optionalNumber(hop.last_ms),
      avg_ms: optionalNumber(hop.avg_ms),
      best_ms: optionalNumber(hop.best_ms),
      worst_ms: optionalNumber(hop.worst_ms),
      stddev_ms: optionalNumber(hop.stddev_ms),
    })) : [],
  })).filter((run) => Number.isFinite(run.id) && Number.isFinite(run.target_id))
}

function runState(run?: CheckRun): PathState {
  if (!run) return 'unknown'
  if (run.status === 'success') return 'healthy'
  if (run.status === 'degraded') return 'warning'
  return 'down'
}

function stateLabel(state: PathState) {
  return { healthy: 'Доступно', warning: 'Деградация', down: 'Недоступно', unknown: 'Нет данных' }[state]
}

function formatMetric(value: number | undefined, suffix: string, digits = 1) {
  return value === undefined ? '—' : `${value.toFixed(digits)}${suffix}`
}

function formatDate(value: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function relativeTime(value: string) {
  if (!value) return 'нет данных'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return 'нет данных'
  if (seconds < 60) return `${seconds} сек. назад`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`
  return `${Math.floor(seconds / 3600)} ч. назад`
}

class APIRequestError extends Error {
  constructor(message: string, readonly code = '') { super(message) }
}

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
  return new APIRequestError(body?.error?.message || `${fallback}: ошибка ${response.status}.`, body?.error?.code)
}

function validateTarget(target: TargetDraft) {
  const errors: Record<string, string> = {}
  const addressPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/

  if (!target.name.trim()) errors.name = 'Укажите понятное имя цели.'
  else if (target.name.trim().length > 80) errors.name = 'Имя не должно быть длиннее 80 символов.'

  if (!target.host.trim()) errors.host = 'Укажите IP-адрес или DNS-имя.'
  else if (target.host.length > 253 || !addressPattern.test(target.host)) errors.host = 'Введите адрес без протокола, порта и пути.'

  if (target.probe_mode === 'tcp' && (target.probe_port < 1 || target.probe_port > 65535)) errors.probe_port = 'Порт должен быть от 1 до 65535.'
  if (![5, 10, 20, 50].includes(target.packet_count)) errors.packet_count = 'Выберите 5, 10, 20 или 50 пакетов.'
  if (target.loss_threshold_percent < 0 || target.loss_threshold_percent > 100) errors.loss_threshold_percent = 'Допустимо значение от 0 до 100%.'

  if (target.iperf_enabled) {
    if (!target.iperf_host.trim()) errors.iperf_host = 'Укажите адрес службы iperf3.'
    else if (target.iperf_host.length > 253 || !addressPattern.test(target.iperf_host)) errors.iperf_host = 'Введите адрес без протокола и пути.'
    if (![5201, 5202, 5203, 5204, 5205].includes(target.iperf_port)) errors.iperf_port = 'Выберите порт от 5201 до 5205.'
    if (![5, 10, 15, 30, 60].includes(target.iperf_duration_seconds)) errors.iperf_duration_seconds = 'Выберите длительность 5, 10, 15, 30 или 60 секунд.'
  }

  return errors
}

function TargetForm({ target, saving, serverError, onClose, onSave }: {
  target?: Target
  saving: boolean
  serverError: string
  onClose: () => void
  onSave: (draft: TargetDraft) => Promise<void>
}) {
  const [draft, setDraft] = useState<TargetDraft>(() => target ? {
    name: target.name,
    host: target.host,
    enabled: target.enabled,
    probe_mode: target.probe_mode,
    probe_port: target.probe_port,
    interval_seconds: target.interval_seconds,
    packet_count: target.packet_count,
    loss_threshold_percent: target.loss_threshold_percent,
    iperf_enabled: target.iperf_enabled,
    iperf_host: target.iperf_host,
    iperf_port: target.iperf_port,
    iperf_duration_seconds: target.iperf_duration_seconds,
  } : structuredClone(emptyTarget))
  const [errors, setErrors] = useState<Record<string, string>>({})

  function update<K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: '' }))
  }

  function setProbeMode(mode: ProbeMode) {
    setDraft((current) => ({ ...current, probe_mode: mode, probe_port: mode === 'tcp' ? (current.probe_port || 443) : 0 }))
    setErrors((current) => ({ ...current, probe_port: '' }))
  }

  function setIperfEnabled(enabled: boolean) {
    setDraft((current) => ({
      ...current,
      iperf_enabled: enabled,
      iperf_host: enabled ? (current.iperf_host || current.host) : '',
      iperf_port: enabled ? (current.iperf_port || 5201) : 0,
      iperf_duration_seconds: enabled ? (current.iperf_duration_seconds || 10) : 0,
    }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = validateTarget(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    await onSave({
      ...draft,
      name: draft.name.trim(),
      host: draft.host.trim(),
      probe_port: draft.probe_mode === 'tcp' ? draft.probe_port : 0,
      iperf_host: draft.iperf_enabled ? draft.iperf_host.trim() : '',
      iperf_port: draft.iperf_enabled ? draft.iperf_port : 0,
      iperf_duration_seconds: draft.iperf_enabled ? draft.iperf_duration_seconds : 0,
    })
  }

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <aside className="target-drawer" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="target-form-title">
        <div className="drawer-heading">
          <div><p className="eyebrow">Параметры проверки</p><h2 id="target-form-title">{target ? 'Изменить цель' : 'Добавить цель'}</h2></div>
          <Button variant="ghost" size="icon" className="icon-button close-button" type="button" disabled={saving} onClick={onClose} aria-label="Закрыть"><Icon name="close" size={17} /></Button>
        </div>
        <form className="target-form" onSubmit={submit} noValidate>
          <div className="form-section">
            <h3>Основные параметры</h3>
            <label className="field pl-ui-field"><span>Имя цели</span><input className="pl-ui-input" autoFocus value={draft.name} onChange={(e) => update('name', e.target.value)} placeholder="Например, сервер" aria-invalid={Boolean(errors.name)} /><small>Название, которое будет видно на главном экране.</small>{errors.name && <em>{errors.name}</em>}</label>
            <label className="field pl-ui-field"><span>IP-адрес или DNS-имя</span><input className="pl-ui-input" value={draft.host} onChange={(e) => update('host', e.target.value)} placeholder="192.0.2.20" aria-invalid={Boolean(errors.host)} /><small>Без http://, порта и пути.</small>{errors.host && <em>{errors.host}</em>}</label>
            <fieldset className="field mode-field"><legend>Режим проверки</legend><div className="mode-options">
              {(['mtr', 'icmp', 'tcp'] as ProbeMode[]).map((mode) => <label key={mode} className={draft.probe_mode === mode ? 'selected' : ''}><input type="radio" name="probe-mode" value={mode} checked={draft.probe_mode === mode} onChange={() => setProbeMode(mode)} /><strong>{modeLabels[mode]}</strong><small>{mode === 'mtr' ? 'Маршрут, задержка и потери по узлам' : mode === 'icmp' ? 'Быстрая проверка доступности' : 'Проверка доступности TCP-порта'}</small></label>)}
            </div></fieldset>
            {draft.probe_mode === 'tcp' && <label className="field pl-ui-field tcp-port-field"><span>TCP-порт</span><input className="pl-ui-input" type="number" min="1" max="65535" value={draft.probe_port} onChange={(e) => update('probe_port', Number(e.target.value))} aria-invalid={Boolean(errors.probe_port)} /><small>Порт, доступность которого проверяет Wayline.</small>{errors.probe_port && <em>{errors.probe_port}</em>}</label>}
            <label className="toggle-row target-enabled-row"><span><strong>Цель активна</strong><small>Выключенную цель можно настроить заранее: проверки начнутся только после включения.</small></span><input type="checkbox" checked={draft.enabled} onChange={(e) => update('enabled', e.target.checked)} /><i /></label>
          </div>

          <div className="form-section form-grid">
            <h3>Расписание и пороги</h3>
            <label className="field pl-ui-field"><span>Интервал</span><select className="pl-ui-select" value={draft.interval_seconds} onChange={(e) => update('interval_seconds', Number(e.target.value))}>{Object.entries(intervalLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>Как часто Wayline запускает проверку.</small></label>
            <label className="field pl-ui-field"><span>Количество пакетов</span><select className="pl-ui-select" value={draft.packet_count} onChange={(e) => update('packet_count', Number(e.target.value))} aria-invalid={Boolean(errors.packet_count)}>{[5, 10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}</select><small>Больше пакетов — точнее результат и выше нагрузка.</small>{errors.packet_count && <em>{errors.packet_count}</em>}</label>
            <label className="field pl-ui-field"><span>Порог потерь, %</span><input className="pl-ui-input" type="number" min="0" max="100" step="0.1" value={draft.loss_threshold_percent} onChange={(e) => update('loss_threshold_percent', Number(e.target.value))} aria-invalid={Boolean(errors.loss_threshold_percent)} /><small>При превышении цель считается деградировавшей.</small>{errors.loss_threshold_percent && <em>{errors.loss_threshold_percent}</em>}</label>
          </div>

          <div className="form-section iperf-section">
            <label className="toggle-row"><span><strong>Проверять скорость соединения через iperf3</strong><small>Сервер iperf3 может находиться во внутренней сети или быть доступен через интернет. Тест не влияет на основную MTR-проверку.</small></span><input type="checkbox" checked={draft.iperf_enabled} onChange={(e) => setIperfEnabled(e.target.checked)} /><i /></label>
            {draft.iperf_enabled && <div className="iperf-fields">
              <label className="field pl-ui-field"><span>Адрес iperf3</span><input className="pl-ui-input" value={draft.iperf_host} onChange={(e) => update('iperf_host', e.target.value)} placeholder="iperf.example.invalid" aria-invalid={Boolean(errors.iperf_host)} />{errors.iperf_host && <em>{errors.iperf_host}</em>}</label>
              <label className="field pl-ui-field"><span>Порт</span><select className="pl-ui-select" value={draft.iperf_port} onChange={(e) => update('iperf_port', Number(e.target.value))} aria-invalid={Boolean(errors.iperf_port)}>{[5201, 5202, 5203, 5204, 5205].map((value) => <option key={value} value={value}>{value}</option>)}</select>{errors.iperf_port && <em>{errors.iperf_port}</em>}</label>
              <label className="field pl-ui-field"><span>Длительность, сек.</span><select className="pl-ui-select" value={draft.iperf_duration_seconds} onChange={(e) => update('iperf_duration_seconds', Number(e.target.value))} aria-invalid={Boolean(errors.iperf_duration_seconds)}>{[5, 10, 15, 30, 60].map((value) => <option key={value} value={value}>{value} сек.</option>)}</select>{errors.iperf_duration_seconds && <em>{errors.iperf_duration_seconds}</em>}</label>
            </div>}
          </div>

          {serverError && <div className="inline-error" role="alert">{serverError}</div>}
          <div className="drawer-actions"><Button variant="ghost" className="ghost-action" type="button" disabled={saving} onClick={onClose}>Отмена</Button><Button variant="default" className="primary-button" type="submit" disabled={saving}>{saving ? 'Сохранение…' : target ? 'Сохранить изменения' : 'Добавить цель'}</Button></div>
        </form>
      </aside>
    </div>
  )
}

function TargetsView() {
  const [targets, setTargets] = useState<Target[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [formTarget, setFormTarget] = useState<Target | null | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState('')
  const modalOpen = formTarget !== undefined || deleteTarget !== null
  const modalTrigger = useRef<HTMLButtonElement | null>(null)
  const modalSaving = useRef(saving)
  modalSaving.current = saving
  useEffect(() => {
    if (!modalOpen) return
    const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
    if (!dialog) return
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')).filter((element) => element.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modalSaving.current) { event.preventDefault(); setFormTarget(undefined); setDeleteTarget(null) }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (modalTrigger.current?.isConnected) modalTrigger.current.focus()
    }
  }, [modalOpen])

  async function loadTargets() {
    setLoading(true)
    setLoadError('')
    try {
      const response = await waylineFetch('/api/v1/targets', { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Сервер вернул ошибку ${response.status}.`)
      const body = await response.json() as Target[] | { targets: Target[] }
      setTargets(Array.isArray(body) ? body : body.targets)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить цели.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadTargets() }, [])

  async function saveTarget(draft: TargetDraft) {
    setSaving(true)
    setServerError('')
    try {
      const editing = formTarget !== null && formTarget !== undefined
      const response = await waylineFetch(`/api/v1/targets${editing ? `/${encodeURIComponent(formTarget.id)}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string; fields?: Record<string, string> } } | null
        const fieldDetails = Object.values(body?.error?.fields ?? {}).join(' ')
        throw new Error(`${body?.error?.message || `Не удалось сохранить цель: ошибка ${response.status}.`}${fieldDetails ? `: ${fieldDetails}` : ''}`)
      }
      setFormTarget(undefined)
      await loadTargets()
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Не удалось сохранить цель.')
    } finally {
      setSaving(false)
    }
  }

  async function removeTarget() {
    if (!deleteTarget) return
    setSaving(true)
    setServerError('')
    try {
      const response = await waylineFetch(`/api/v1/targets/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE', headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Не удалось удалить цель: ошибка ${response.status}.`)
      setDeleteTarget(null)
      await loadTargets()
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Не удалось удалить цель.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="targets-page workspace-wide">
    <div className="page-toolbar targets-toolbar"><div><h1>Цели</h1><p>Направления сетевых проверок и параметры диагностики</p></div><Button variant="default" className="primary-button add-target-button" onClick={(event) => { modalTrigger.current = event.currentTarget; setServerError(''); setFormTarget(null) }}><Icon name="plus" size={16} />Добавить цель</Button></div>

    <section className="panel pl-ui-panel targets-panel">
      <div className="targets-panel-heading"><PanelTitle icon="target" title="Настроенные цели" />{!loading && !loadError && <span className="target-count">{targets.length} {targets.length === 1 ? 'цель' : targets.length > 1 && targets.length < 5 ? 'цели' : 'целей'}</span>}</div>
      {loading && <div className="target-state" aria-live="polite"><span className="loading-ring" /><strong>Загружаем цели</strong><small>Получаем актуальную конфигурацию Wayline.</small></div>}
      {!loading && loadError && <div className="target-state error-state" role="alert"><span className="state-symbol">!</span><strong>Не удалось загрузить цели</strong><small>{loadError}</small><Button variant="secondary" size="sm" className="secondary-button compact-button" onClick={() => void loadTargets()}>Повторить</Button></div>}
      {!loading && !loadError && targets.length === 0 && <div className="target-state empty-state"><span className="state-symbol">◎</span><strong>Целей пока нет</strong><small>Добавьте первый сервер или сетевой узел. Wayline начнёт собирать MTR и историю доступности без изменения конфигурационных файлов.</small><Button variant="default" className="primary-button" onClick={(event) => { modalTrigger.current = event.currentTarget; setFormTarget(null) }}>Добавить первую цель</Button></div>}
      {!loading && !loadError && targets.length > 0 && <div className="target-table" role="table" aria-label="Настроенные цели">
        <div className="target-row target-head" role="row"><span>Цель</span><span>Режим</span><span>Интервал</span><span>Пакеты</span><span>Порог потерь</span><span>iperf3</span><span>Действия</span></div>
        {targets.map((target) => <div className="target-row" role="row" key={target.id}>
          <span className="target-identity"><ConfigStatusDot enabled={target.enabled} /><span><strong>{target.name}</strong><small>{target.host}</small></span></span>
          <span><b className="mode-badge">{modeLabels[target.probe_mode]}{target.probe_mode === 'tcp' ? `:${target.probe_port}` : ''}</b></span><span>{intervalLabels[target.interval_seconds] ?? `${target.interval_seconds} сек.`}</span><span>{target.packet_count}</span><span>{target.loss_threshold_percent}%</span><span>{target.iperf_enabled ? <b className="iperf-enabled">{target.iperf_host}:{target.iperf_port}</b> : <span className="muted-value">Выключен</span>}</span>
          <span className="row-actions"><button onClick={(event) => { modalTrigger.current = event.currentTarget; setServerError(''); setFormTarget(target) }}>Изменить</button><button className="danger-link" onClick={(event) => { modalTrigger.current = event.currentTarget; setServerError(''); setDeleteTarget(target) }}>Удалить</button></span>
        </div>)}
      </div>}
    </section>
    {formTarget !== undefined && <TargetForm target={formTarget ?? undefined} saving={saving} serverError={serverError} onClose={() => setFormTarget(undefined)} onSave={saveTarget} />}
    {deleteTarget && <div className="drawer-layer confirm-layer" role="presentation"><div className="confirm-dialog pl-ui-native-dialog" tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><div className="dialog-heading"><h2 id="delete-title">Удалить цель «{deleteTarget.name}»?</h2><Button variant="ghost" size="icon" className="icon-button" disabled={saving} onClick={() => setDeleteTarget(null)} aria-label="Закрыть"><Icon name="close" size={17} /></Button></div><p>Цель, вся история её проверок и сохранённые маршруты будут безвозвратно удалены. Это действие нельзя отменить.</p>{serverError && <div className="inline-error" role="alert">{serverError}</div>}<div className="drawer-actions"><Button variant="ghost" className="ghost-action" disabled={saving} onClick={() => setDeleteTarget(null)}>Отмена</Button><Button variant="destructive" className="danger-button" disabled={saving} onClick={() => void removeTarget()}>{saving ? 'Удаление…' : 'Удалить цель'}</Button></div></div></div>}
  </div>
}

type MainSection = 'overview' | 'availability' | 'speed' | 'targets'
type ToastMessage = { id: number; tone: 'error' | 'success' | 'info'; text: string }

function directionLabel(direction?: string) {
  if (direction === 'upload') return 'Отправка · от Wayline к серверу'
  if (direction === 'download') return 'Скачивание · от сервера к Wayline'
  return 'Направление не указано'
}

function MonitoringView({ section, requestedTarget }: { section: Exclude<MainSection, 'targets'>; requestedTarget: number | null }) {
  const [targets, setTargets] = useState<Target[]>([])
  const [runs, setRuns] = useState<CheckRun[]>([])
  const [selectedID, setSelectedID] = useState<number | null>(requestedTarget)
  const [selectedRuns, setSelectedRuns] = useState<CheckRun[]>([])
  const [selectedRun, setSelectedRun] = useState<CheckRun | undefined>()
  const [inspectedRunID, setInspectedRunID] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [runningKind, setRunningKind] = useState<'path' | 'iperf' | null>(null)
  const [direction, setDirection] = useState<'download' | 'upload'>('download')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const detailsRequestID = useRef(0)
  const toastTimer = useRef<number | null>(null)

  function showToast(text: string, tone: ToastMessage['tone'] = 'error') {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), tone, text })
    toastTimer.current = window.setTimeout(() => setToast(null), 10_000)
  }

  async function loadOverview(silent = false) {
    if (!silent) {
      setLoading(true)
      setLoadError('')
    }
    try {
      const [targetsResponse, latestResponse] = await Promise.all([
        waylineFetch('/api/v1/targets', { headers: { Accept: 'application/json' } }),
        waylineFetch('/api/v1/checks/latest?kind=path', { headers: { Accept: 'application/json' } }),
      ])
      if (!targetsResponse.ok) throw await responseError(targetsResponse, 'Не удалось загрузить цели')
      if (!latestResponse.ok) throw await responseError(latestResponse, 'Не удалось загрузить текущие статусы')
      const targetsBody = await targetsResponse.json() as Target[] | { targets?: Target[] }
      const nextTargets = Array.isArray(targetsBody) ? targetsBody : (targetsBody.targets ?? [])
      const nextRuns = parseRuns(await latestResponse.json())
      setTargets(nextTargets)
      setRuns(nextRuns)
      setSelectedID((current) => requestedTarget !== null ? (current ?? requestedTarget) : current && nextTargets.some((target) => target.id === current) ? current : (nextTargets[0]?.id ?? null))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить обзор.'
      if (silent) showToast(`Не удалось обновить данные: ${message}`)
      else setLoadError(message)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  async function loadTargetRuns(targetID: number, silent = false) {
    const requestID = ++detailsRequestID.current
    if (!silent) {
      setDetailsLoading(true)
    }
    try {
      const response = await waylineFetch(`/api/v1/checks?target_id=${encodeURIComponent(targetID)}&limit=50`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw await responseError(response, 'Не удалось загрузить историю')
      const nextRuns = parseRuns(await response.json()).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      if (requestID !== detailsRequestID.current) return
      setSelectedRuns(nextRuns)
      const pathToShow = nextRuns.find((run) => run.kind === 'path' && run.id === inspectedRunID) ?? nextRuns.find((run) => run.kind === 'path')
      if (!pathToShow) {
        setSelectedRun(undefined)
        return
      }
      const detailResponse = await waylineFetch(`/api/v1/checks/${encodeURIComponent(pathToShow.id)}`, { headers: { Accept: 'application/json' } })
      if (requestID !== detailsRequestID.current) return
      if (!detailResponse.ok) {
        setSelectedRun(pathToShow)
        return
      }
      const detailBody = await detailResponse.json() as unknown
      const detailCandidate = isRecord(detailBody) && (isRecord(detailBody.check) || isRecord(detailBody.run))
        ? (isRecord(detailBody.check) ? detailBody.check : detailBody.run)
        : detailBody
      if (requestID === detailsRequestID.current) setSelectedRun(parseRuns([detailCandidate])[0] ?? pathToShow)
    } catch (error) {
      if (requestID !== detailsRequestID.current) return
      if (!silent) {
        setSelectedRuns([])
        setSelectedRun(undefined)
      }
      showToast(error instanceof Error ? error.message : 'Не удалось загрузить историю.')
    } finally {
      if (!silent && requestID === detailsRequestID.current) setDetailsLoading(false)
    }
  }

  useEffect(() => {
    let refreshInProgress = false
    void loadOverview()
    const timer = window.setInterval(() => {
      if (refreshInProgress) return
      refreshInProgress = true
      void loadOverview(true).finally(() => { refreshInProgress = false })
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])
  useEffect(() => {
    if (selectedID === null || selectedID < 1) {
      detailsRequestID.current += 1
      setSelectedRuns([])
      setSelectedRun(undefined)
      return
    }
    void loadTargetRuns(selectedID)
    let refreshInProgress = false
    const timer = window.setInterval(() => {
      if (refreshInProgress) return
      refreshInProgress = true
      void loadTargetRuns(selectedID, true).finally(() => { refreshInProgress = false })
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [selectedID, inspectedRunID])

  async function inspectRun(run: CheckRun) {
    if (run.kind !== 'path') return
    setInspectedRunID(run.id)
    setDetailsLoading(true)
    const requestID = ++detailsRequestID.current
    try {
      const response = await waylineFetch(`/api/v1/checks/${encodeURIComponent(run.id)}`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw await responseError(response, 'Не удалось загрузить маршрут')
      const body = await response.json() as unknown
      const candidate = isRecord(body) && (isRecord(body.check) || isRecord(body.run)) ? (isRecord(body.check) ? body.check : body.run) : body
      if (requestID === detailsRequestID.current) setSelectedRun(parseRuns([candidate])[0] ?? run)
    } catch (error) {
      if (requestID === detailsRequestID.current) showToast(error instanceof Error ? error.message : 'Не удалось загрузить маршрут.')
    } finally {
      if (requestID === detailsRequestID.current) setDetailsLoading(false)
    }
  }

  async function startCheck(kind: 'path' | 'iperf', targetID = selectedID) {
    if (targetID === null) return
    setRunningKind(kind)
    try {
      const response = await waylineFetch(`/api/v1/targets/${encodeURIComponent(targetID)}/checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(kind === 'iperf' ? { kind, direction } : { kind }),
      })
      if (!response.ok) throw await responseError(response, 'Не удалось запустить проверку')
      await Promise.all([loadOverview(true), loadTargetRuns(targetID, true)])
      showToast(kind === 'iperf' ? 'Проверка скорости завершена' : 'Проверка доступности завершена', 'success')
    } catch (error) {
      const message = error instanceof APIRequestError && error.code === 'check_already_running'
        ? 'Проверка этой цели выполняется в данный момент'
        : error instanceof Error ? error.message : 'Не удалось запустить проверку.'
      showToast(message)
    } finally {
      setRunningKind(null)
    }
  }

  const selectedTarget = targets.find((target) => target.id === selectedID)
  const latestByTarget = new Map<number, CheckRun>()
  runs.filter((run) => run.kind === 'path').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).forEach((run) => {
    if (!latestByTarget.has(run.target_id)) latestByTarget.set(run.target_id, run)
  })
  const targetStates = targets.filter((target) => target.enabled).map((target) => runState(latestByTarget.get(target.id)))
  const latestIperf = selectedRuns.find((run) => run.kind === 'iperf')
  const pathHistory = selectedRuns.filter((run) => run.kind === 'path')
  const unknownCount = targetStates.filter((state) => state === 'unknown').length
  const iperfTargets = targets.filter((target) => target.iperf_enabled)

  useEffect(() => {
    if (requestedTarget === null && section === 'speed' && iperfTargets.length > 0 && !iperfTargets.some((target) => target.id === selectedID)) {
      setSelectedID(iperfTargets[0].id)
    }
  }, [section, targets, selectedID, requestedTarget])

  if (loading) return <div className="overview-state"><span className="loading-ring" /><strong>Загружаем сетевую сводку</strong><small>Получаем цели и последние проверки Wayline.</small></div>
  if (loadError) return <div className="overview-state error-state" role="alert"><span className="state-symbol">!</span><strong>Обзор недоступен</strong><small>{loadError}</small><Button variant="secondary" size="sm" className="secondary-button compact-button" onClick={() => void loadOverview()}>Повторить</Button></div>
  if (requestedTarget !== null && !targets.some((target) => target.id === requestedTarget)) return <div className="overview-state" role="status"><strong>Цель не найдена</strong><small>Цель из ссылки удалена или недоступна в этом экземпляре Wayline.</small><a className="primary-button pl-ui-button pl-ui-button-default inline-action" href={`#${section}`}>Открыть все цели</a></div>
  if (requestedTarget !== null && section === 'speed' && !selectedTarget?.iperf_enabled) return <div className="overview-state" role="status"><strong>Проверка скорости не настроена</strong><small>Для цели «{selectedTarget?.name}» необходимо включить iperf3.</small><a className="primary-button pl-ui-button pl-ui-button-default inline-action" href="#targets">Настроить цели</a></div>
  if (targets.length === 0) return <div className="overview-state"><span className="state-symbol">◎</span><strong>Нет целей для проверки</strong><small>Добавьте первую цель через WebUI — править конфиги не потребуется.</small><a className="primary-button pl-ui-button pl-ui-button-default inline-action" href="#targets">Перейти к целям</a></div>

  const activeState = runState(selectedRun)
  const routePanel = <article className="panel pl-ui-panel route-panel">
    <div className="panel-heading route-heading">
      <PanelTitle icon="route" title={inspectedRunID && inspectedRunID !== pathHistory[0]?.id && selectedRun?.id === inspectedRunID ? 'Исторический маршрут' : 'Последний маршрут'} detail={`${selectedTarget?.name ?? ''} · ${selectedTarget?.host ?? ''}`} />
      <div className="route-state"><StatusDot state={activeState} /><span><strong className={`state-text-${activeState}`}>{stateLabel(activeState)}</strong><small>{selectedRun ? relativeTime(selectedRun.finished_at || selectedRun.started_at) : 'проверок ещё нет'}</small></span></div>
    </div>
    {detailsLoading ? <div className="route-empty"><span className="loading-ring" /><strong>Загружаем маршрут</strong></div> : !selectedRun ? <div className="route-empty"><span className="state-symbol">◎</span><strong>Данных маршрута ещё нет</strong><small>Запустите первую проверку для выбранной цели.</small></div> : <>
      <div className="route-metrics"><div><span>Доступность</span><strong>{selectedRun.loss_percent === undefined ? '—' : `${Math.max(0, 100 - selectedRun.loss_percent).toFixed(1)}%`}</strong></div><div><span>Средняя задержка</span><strong>{formatMetric(selectedRun.avg_latency_ms, ' мс')}</strong></div><div><span>Потери</span><strong className={selectedRun.loss_percent ? 'warning-text' : ''}>{formatMetric(selectedRun.loss_percent, '%')}</strong></div><div><span>Джиттер</span><strong>{formatMetric(selectedRun.jitter_ms, ' мс')}</strong></div></div>
      {selectedRun.error_message && <div className="run-error">Ошибка проверки: {selectedRun.error_message}</div>}
      {selectedRun.hops.length > 0 ? <>
        <div className="route-visual" aria-label={`Трасса из ${selectedRun.hops.length} узлов`}><span className="route-line" />{selectedRun.hops.map((hop) => <div className="route-node" key={`${hop.hop_number}-${hop.host}`}><span className={`node-orbit ${hop.loss_percent ? 'node-warning' : ''}`}>{hop.hop_number}</span><strong title={hop.host || '*'}>{hop.host || '*'}</strong><small>{formatMetric(hop.avg_ms, ' мс')}</small></div>)}</div>
        <div className="hop-table" role="table" aria-label="Результаты MTR по узлам"><div className="hop-row hop-head" role="row"><span>№</span><span>Узел</span><span>Среднее</span><span>Потери</span></div>{selectedRun.hops.map((hop) => <div className="hop-row" role="row" key={`${hop.hop_number}-${hop.host}-${hop.ip ?? ''}`}><span>{String(hop.hop_number).padStart(2, '0')}</span><span><strong>{hop.host || '*'}</strong><small>{hop.ip || `${hop.packets_sent ?? '—'} пакетов`}</small></span><span>{formatMetric(hop.avg_ms, ' мс')}</span><span className={hop.loss_percent ? 'warning-text' : ''}>{formatMetric(hop.loss_percent, '%')}</span></div>)}</div>
      </> : <div className="route-empty compact"><small>Поузловая детализация в этой проверке отсутствует.</small></div>}
    </>}
  </article>

  const toastNode = toast && <div key={toast.id} className={`app-toast toast-${toast.tone}`} role="status"><span>{toast.tone === 'success' ? '✓' : '!'}</span><strong>{toast.text}</strong><button type="button" onClick={() => setToast(null)} aria-label="Закрыть уведомление">×</button><i /></div>

  if (section === 'availability') return <div className="workspace-wide">
    {toastNode}<div className="page-toolbar"><div><h1>Доступность</h1><p>Текущее состояние целей и подробный маршрут до выбранного узла</p></div><Button variant="default" className="primary-button" disabled={!selectedTarget?.enabled || runningKind !== null} onClick={() => void startCheck('path')}>{runningKind === 'path' ? 'Проверка…' : 'Проверить выбранную цель'}</Button></div>
    <section className="availability-layout"><article className="panel pl-ui-panel availability-list"><div className="panel-heading"><PanelTitle icon="activity" title="Последние проверки" /><span className="target-count">{targets.length}</span></div><div className="availability-table"><div className="availability-row availability-head"><span>Цель</span><span>Статус</span><span>Задержка</span><span>Потери</span><span>Проверка</span></div>{targets.map((target) => { const latest = latestByTarget.get(target.id); const state = target.enabled ? runState(latest) : 'unknown'; return <button className={`availability-row ${target.id === selectedID ? 'selected' : ''}`} key={target.id} onClick={() => { setInspectedRunID(null); setSelectedID(target.id) }}><span className="target-identity"><StatusDot state={state} /><span><strong>{target.name}</strong><small>{target.host}</small></span></span><span className={`state-text-${state}`}>{target.enabled ? stateLabel(state) : 'Выключена'}</span><span>{formatMetric(latest?.avg_latency_ms, ' мс')}</span><span>{formatMetric(latest?.loss_percent, '%')}</span><span>{latest ? relativeTime(latest.finished_at || latest.started_at) : '—'}</span></button> })}</div></article>{routePanel}</section>
    <section className="panel pl-ui-panel availability-history"><div className="panel-heading"><PanelTitle icon="history" title="История доступности" detail={selectedTarget?.name} /><span className="target-count">{pathHistory.length}</span></div>{pathHistory.length === 0 ? <div className="history-empty">Проверок доступности для этой цели пока нет.</div> : <div className="run-history"><div className="run-row availability-history-row run-head"><span>Статус</span><span>Время</span><span>Задержка</span><span>Потери</span><span>Длительность</span></div>{pathHistory.map((run) => <button className={`run-row availability-history-row inspectable ${run.id === inspectedRunID ? 'selected' : ''}`} key={run.id} onClick={() => void inspectRun(run)}><span className="run-status"><StatusDot state={runState(run)} />{stateLabel(runState(run))}</span><span>{formatDate(run.finished_at || run.started_at)}</span><span>{formatMetric(run.avg_latency_ms, ' мс')}</span><span>{formatMetric(run.loss_percent, '%')}</span><span>{(run.duration_ms / 1000).toFixed(1)} сек.</span></button>)}</div>}</section>
  </div>

  if (section === 'speed') return <div>
    {toastNode}<div className="page-toolbar"><div><h1>Скорость соединения</h1><p>Проверка пропускной способности до любого доступного сервера iperf3 — внутри сети или через интернет</p></div></div>
    {iperfTargets.length === 0 ? <section className="panel pl-ui-panel target-state"><span className="state-symbol">↗</span><strong>Нет целей с iperf3</strong><small>Включите проверку скорости в настройках нужной цели и укажите адрес сервера iperf3.</small><a className="primary-button pl-ui-button pl-ui-button-default inline-action" href="#targets">Перейти к целям</a></section> : <section className="speed-layout"><article className="panel pl-ui-panel speed-control"><div className="panel-heading"><PanelTitle icon="speed" title="Параметры проверки" /><span className="tag">iperf3</span></div><div className="speed-form"><label><span>Цель</span><select className="pl-ui-select" value={selectedID ?? ''} onChange={(e) => setSelectedID(Number(e.target.value))}>{iperfTargets.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.iperf_host}:{target.iperf_port}</option>)}</select></label><fieldset><legend>Направление</legend><button className={direction === 'download' ? 'active' : ''} onClick={() => setDirection('download')}><strong>Скачивание</strong><small>От сервера iperf3 к Wayline</small></button><button className={direction === 'upload' ? 'active' : ''} onClick={() => setDirection('upload')}><strong>Отправка</strong><small>От Wayline к серверу iperf3</small></button></fieldset><div className="speed-config"><span>Длительность<strong>{selectedTarget?.iperf_duration_seconds ?? '—'} сек.</strong></span><span>Сервер<strong>{selectedTarget?.iperf_host || '—'}</strong></span><span>Порт<strong>{selectedTarget?.iperf_port || '—'}</strong></span></div><Button variant="default" className="primary-button" disabled={!selectedTarget?.enabled || !selectedTarget?.iperf_enabled || runningKind !== null} onClick={() => void startCheck('iperf')}>{runningKind === 'iperf' ? 'Тестирование…' : 'Запустить проверку скорости'}</Button></div></article><article className="panel pl-ui-panel speed-result"><div className="panel-heading"><PanelTitle icon="activity" title="Последний результат" detail={selectedTarget?.name} /></div>{latestIperf ? <div className="speed-reading"><StatusDot state={runState(latestIperf)} /><strong>{latestIperf.throughput_bps === undefined ? '—' : (latestIperf.throughput_bps / 1_000_000).toFixed(1)}</strong><span>Мбит/с</span><small>{directionLabel(latestIperf.direction)} · {formatDate(latestIperf.finished_at || latestIperf.started_at)}</small>{latestIperf.error_message && <em>{latestIperf.error_message}</em>}</div> : <div className="throughput-empty">Для этой цели тестов скорости ещё нет.</div>}</article></section>}
    {iperfTargets.length > 0 && <section className="panel pl-ui-panel speed-history"><div className="panel-heading"><PanelTitle icon="history" title="История скорости" /></div><div className="run-history"><div className="run-row speed-history-row run-head"><span>Статус</span><span>Время</span><span>Направление</span><span>Скорость</span><span>Длительность</span></div>{selectedRuns.filter((run) => run.kind === 'iperf').map((run) => <div className="run-row speed-history-row" key={run.id}><span className="run-status"><StatusDot state={runState(run)} />{stateLabel(runState(run))}</span><span>{formatDate(run.finished_at || run.started_at)}</span><span>{directionLabel(run.direction)}</span><span>{formatMetric(run.throughput_bps === undefined ? undefined : run.throughput_bps / 1_000_000, ' Мбит/с')}</span><span>{(run.duration_ms / 1000).toFixed(1)} сек.</span></div>)}</div></section>}
  </div>

  return <div>
    {toastNode}
    <div className="page-toolbar">
      <div><h1>Обзор сети</h1><p>{targets.length} целей · {targets.filter((target) => target.enabled).length} активных{selectedRun ? ` · обновлено ${relativeTime(selectedRun.finished_at || selectedRun.started_at)}` : ' · проверок ещё нет'}</p></div>
      <Button variant="default" className="primary-button" disabled={!selectedTarget?.enabled || runningKind !== null} onClick={() => void startCheck('path')}><Icon name="play" size={16} />{runningKind === 'path' ? 'Проверка…' : 'Проверить маршрут'}</Button>
    </div>

    <section className="summary-grid" aria-label="Сводка">
      <article className="summary-card accent-ice"><span>Доступны</span><strong>{targetStates.filter((state) => state === 'healthy').length}</strong><small>последняя проверка успешна</small></article>
      <article className="summary-card accent-gold"><span>С деградацией</span><strong>{targetStates.filter((state) => state === 'warning').length}</strong><small>порог потерь превышен</small></article>
      <article className="summary-card accent-red"><span>Недоступны</span><strong>{targetStates.filter((state) => state === 'down').length}</strong><small>проверка завершилась ошибкой</small></article>
      <article className="summary-card accent-blue"><span>Без данных</span><strong>{unknownCount}</strong><small>из {targetStates.length} активных целей</small></article>
    </section>

    <section className="workspace-grid" id="overview">
      <article className="panel pl-ui-panel path-list-panel">
        <div className="panel-heading"><PanelTitle icon="activity" title="Состояние сети" /><span className="target-count">{targets.length}</span></div>
        <div className="path-list">
          {targets.map((target) => {
            const latest = latestByTarget.get(target.id)
            const state = target.enabled ? runState(latest) : 'unknown'
            return <button key={target.id} className={`path-row ${target.id === selectedID ? 'selected' : ''}`} onClick={() => { setInspectedRunID(null); setSelectedID(target.id) }}>
              <StatusDot state={state} />
              <span className="path-copy"><strong>{target.name}</strong><small>{target.host}{target.enabled ? '' : ' · выключена'}</small></span>
              <span className="path-values"><strong>{formatMetric(latest?.avg_latency_ms, ' мс')}</strong><small>{formatMetric(latest?.loss_percent, '%')} потерь</small></span>
            </button>
          })}
        </div>
      </article>

      {routePanel}
    </section>

    <section className="lower-grid" id="history">
      <article className="panel pl-ui-panel history-panel">
        <div className="panel-heading"><PanelTitle icon="history" title="История проверок" detail={selectedTarget?.name} /><span className="target-count">{selectedRuns.length}</span></div>
        {selectedRuns.length === 0 ? <div className="history-empty">История для этой цели пока пуста.</div> : <div className="run-history" role="table" aria-label="История проверок">
          <div className="run-row run-head" role="row"><span>Статус</span><span>Тип</span><span>Время</span><span>Задержка / скорость</span><span>Потери</span></div>
          {selectedRuns.map((run) => <button className={`run-row ${run.kind === 'path' ? 'inspectable' : ''} ${run.id === inspectedRunID ? 'selected' : ''}`} role="row" key={run.id} disabled={run.kind !== 'path'} title={run.kind === 'path' ? 'Показать маршрут этого запуска' : undefined} onClick={() => void inspectRun(run)}><span className="run-status"><StatusDot state={runState(run)} />{stateLabel(runState(run))}</span><span>{run.kind === 'iperf' ? 'iperf3' : 'Маршрут'}</span><span>{formatDate(run.finished_at || run.started_at)}</span><span>{run.kind === 'iperf' ? formatMetric(run.throughput_bps === undefined ? undefined : run.throughput_bps / 1_000_000, ' Мбит/с') : formatMetric(run.avg_latency_ms, ' мс')}</span><span>{formatMetric(run.loss_percent, '%')}</span></button>)}
        </div>}
      </article>

      <article className="panel pl-ui-panel throughput-panel" id="throughput">
        <div className="panel-heading"><PanelTitle icon="speed" title="Скорость соединения" detail={selectedTarget?.iperf_enabled ? `${selectedTarget.iperf_host}:${selectedTarget.iperf_port}` : 'iperf3 не настроен'} /><span className="tag">iperf3</span></div>
        {latestIperf ? <><div className="throughput-value"><strong>{latestIperf.throughput_bps === undefined ? '—' : (latestIperf.throughput_bps / 1_000_000).toFixed(0)}</strong><span>Мбит/с</span></div><div className="throughput-meta"><span>{directionLabel(latestIperf.direction)}</span><span>{formatDate(latestIperf.finished_at || latestIperf.started_at)}</span></div>{latestIperf.error_message && <div className="throughput-error">{latestIperf.error_message}</div>}</> : <div className="throughput-empty">Тестов iperf3 ещё нет.</div>}
        <div className="overview-speed-actions"><Button variant="secondary" className="secondary-button" disabled={!selectedTarget?.enabled || !selectedTarget?.iperf_enabled || runningKind !== null} title={!selectedTarget?.iperf_enabled ? 'iperf3 выключен в настройках цели' : undefined} onClick={() => void startCheck('iperf')}>{runningKind === 'iperf' ? 'Тестирование…' : 'Запустить тест'}</Button><a className="ghost-button pl-ui-button pl-ui-button-ghost" href="#speed">Открыть раздел</a></div>
      </article>
    </section>

    <footer><span>Wayline · PL</span></footer>
  </div>
}

const sections: { id: MainSection; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Обзор сети', icon: 'overview' },
  { id: 'availability', label: 'Доступность', icon: 'activity' },
  { id: 'speed', label: 'Скорость соединения', icon: 'speed' },
  { id: 'targets', label: 'Цели', icon: 'target' },
]

function routeFromHash() {
  const [value, query = ''] = window.location.hash.slice(1).split('?')
  const section = sections.some((item) => item.id === value) ? value as MainSection : 'overview'
  const rawTarget = new URLSearchParams(query).get('target')
  const id = rawTarget && /^\d+$/.test(rawTarget) ? Number(rawTarget) : NaN
  return { section, target: rawTarget === null ? null : Number.isSafeInteger(id) && id > 0 ? id : -1 }
}

function platformURL() {
  const configured = import.meta.env.VITE_PLATFORM_URL
  if (isPlatformIntegrated && !configured) return '/'
  const fallback = '/'
  try {
    const url = new URL(configured || fallback, window.location.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fallback
    return isPlatformIntegrated && url.origin === window.location.origin ? '/' : new URL('/', url).href
  } catch { return fallback }
}

function WaylineWorkspace({ userName }: { userName?: string }) {
  const [logoutError, setLogoutError] = useState('')
  async function logout() {
    setLogoutError('')
    try { await logoutPlatformSession(); window.location.assign('/') }
    catch (error) { setLogoutError(error instanceof Error ? error.message : 'Не удалось выйти. Повторите попытку.') }
  }
  const [route, setRoute] = useState(routeFromHash)
  const { section } = route
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return <PlatformShell
    branding={{name:"PL",subtitle:"PLATFORM",label:"Platform"}}
    platformHref={platformURL()}
    context={`Wayline · ${sections.find((item) => item.id === section)?.label || 'Обзор'}`}
    user={{ name: userName, subtitle: isPlatformIntegrated ? 'Пользователь Платформы' : 'Локальная учётная запись' }}
    wide={section === 'targets' || section === 'availability'}
    onLogout={isPlatformIntegrated ? logout : undefined}
    navigation={<>{sections.map((item) => <a key={item.id} className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} title={item.label} aria-label={item.label} href={`#${item.id}`}><Icon name={item.icon} /><span>{item.label}</span></a>)}</>}
    sidebarFooter={<><a href={platformURL()} title="Платформа"><Icon name="back" size={18}/><span>Платформа</span></a><span className="sidebar-caption">PL · Wayline</span></>}
    banner={logoutError ? <p className="inline-error" role="alert">{logoutError}</p> : undefined}
  >
    {section === 'targets' ? <TargetsView /> : <MonitoringView key={route.target ?? 'all'} section={section} requestedTarget={route.target} />}
  </PlatformShell>
}

export function App() {
  const [userName, setUserName] = useState<string>()
  const [access, setAccess] = useState<'loading' | 'ready' | PlatformAuthError>(isPlatformIntegrated ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!isPlatformIntegrated) return
    let active = true
    let revision = 0
    const unsubscribe = subscribeAuthFailure((error) => {
      revision += 1
      if (active) setAccess(error)
    })
    async function check(initial: boolean) {
      const current = revision
      try {
        const session = await getPlatformSession()
        if (active && current === revision) { setUserName(session ? session.user.name?.trim() || 'Пользователь' : undefined); setAccess('ready') }
      } catch (error) {
        if (active && current === revision && initial) setAccess(error instanceof PlatformAuthError ? error : new PlatformAuthError('network'))
      }
    }
    const onFocus = () => { void check(false) }
    void check(true)
    window.addEventListener('focus', onFocus)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [attempt])

  if (access === 'ready') return <WaylineWorkspace userName={userName} />
  return <main className="platform-access"><section className="panel pl-ui-panel" aria-live="polite">
    <div className="auth-theme"><ThemeButton /></div>
    <PanelTitle icon="route" title="Wayline" />
    <p>{access === 'loading' ? 'Проверяем сессию платформы…' : access.message}</p>
    {access !== 'loading' && <div className="platform-access-actions">
      <a className="primary-button" href="/">{access.kind === '401' ? 'Войти на платформе' : 'На платформу'}</a>
      <Button variant="secondary" className="secondary-button" onClick={() => { setAccess('loading'); setAttempt((value) => value + 1) }}>Повторить</Button>
    </div>}
  </section></main>
}
