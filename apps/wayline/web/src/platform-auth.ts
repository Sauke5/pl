export type AuthFailureKind = '401' | '403' | 'network'

export class PlatformAuthError extends Error {
  readonly kind: AuthFailureKind

  constructor(kind: AuthFailureKind) {
    super(kind === '401'
      ? 'Сессия платформы завершена. Войдите снова.'
      : kind === '403'
        ? 'У вашей учётной записи нет доступа к Wayline.'
        : 'Не удалось связаться с платформой. Повторите попытку.')
    this.name = 'PlatformAuthError'
    this.kind = kind
  }
}

type PublicSession = { authenticated: true; user: { id: string; name: string; admin: true } }
type TransportOptions = { integrated: boolean; base: string; fetch: typeof fetch }

// A separate instance makes the session lifetime explicit and allows isolated tests.
export function createPlatformTransport(options: TransportOptions) {
  if (!['/', '/wayline/'].includes(options.base) || (options.integrated && options.base !== '/wayline/')) {
    throw new Error('Некорректный путь размещения Wayline.')
  }
  let csrf = ''
  let session: PublicSession | undefined
  let pending: Promise<PublicSession | undefined> | undefined
  const listeners = new Set<(error: PlatformAuthError) => void>()

  function failure(kind: AuthFailureKind): PlatformAuthError {
    const error = new PlatformAuthError(kind)
    if (kind !== 'network') {
      csrf = ''
      session = undefined
      for (const listener of listeners) listener(error)
    }
    return error
  }

  async function loadSession(): Promise<PublicSession> {
    let response: Response
    try {
      response = await options.fetch('/api/v1/session', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' },
      })
    } catch { throw failure('network') }
    if (response.status === 401 || response.status === 403) throw failure(String(response.status) as '401' | '403')
    if (!response.ok) throw failure('network')
    let data: { authenticated?: boolean; user?: { id: string; name: string; admin: boolean }; csrf_token?: string }
    try { data = await response.json() } catch { throw failure('network') }
    if (!data || data.authenticated !== true) throw failure('401')
    if (data.user?.admin !== true) throw failure('403')
    if (typeof data.csrf_token !== 'string' || !data.csrf_token) throw failure('network')
    csrf = data.csrf_token
    session = { authenticated: true, user: { id: data.user.id, name: data.user.name, admin: true } }
    return session
  }

  function getPlatformSession(): Promise<PublicSession | undefined> {
    if (!options.integrated) return Promise.resolve(undefined)
    if (!pending) pending = loadSession().finally(() => { pending = undefined })
    return pending
  }

  async function waylineFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, 'https://wayline.invalid')
    if (!path.startsWith('/api/v1/') || url.origin !== 'https://wayline.invalid' ||
      url.pathname !== path.split('?')[0] || url.hash || /[\\%]/.test(url.pathname)) {
      throw new Error('Недопустимый путь запроса Wayline.')
    }
    const method = (init.method || 'GET').toUpperCase()
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method)
    const headers = new Headers(init.headers)
    if (options.integrated) {
      // Refresh before mutations; never replay a mutation after an auth failure.
      if (mutation || !session) await getPlatformSession()
      headers.delete('Authorization')
      headers.delete('X-CSRF-Token')
      if (mutation) headers.set('X-CSRF-Token', csrf)
    }
    let response: Response
    try {
      response = await options.fetch(options.base.slice(0, -1) + path, {
        ...init, method, headers, credentials: 'same-origin', redirect: 'error',
      })
    } catch (error) {
      if (init.signal?.aborted || !options.integrated) throw error
      throw failure('network')
    }
    if (options.integrated && (response.status === 401 || response.status === 403)) {
      throw failure(String(response.status) as '401' | '403')
    }
    return response
  }

  async function logoutPlatformSession(): Promise<void> {
    if (!options.integrated) return
    try {
      await getPlatformSession()
    } catch (error) {
      if (error instanceof PlatformAuthError && error.kind === '401') return
      throw error
    }
    let response: Response
    try {
      response = await options.fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'X-CSRF-Token': csrf },
      })
    } catch { throw failure('network') }
    if (response.status === 401) { failure('401'); return }
    if (response.status === 403) throw failure('403')
    if (!response.ok) throw failure('network')
    csrf = ''
    session = undefined
  }

  return {
    getPlatformSession, waylineFetch, logoutPlatformSession,
    subscribeAuthFailure(listener: (error: PlatformAuthError) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const env = import.meta.env
export const isPlatformIntegrated = env?.VITE_PLATFORM_AUTH === 'true'
export const isPlatformAuthEnabled = isPlatformIntegrated
const transport = createPlatformTransport({
  integrated: isPlatformIntegrated, base: env?.BASE_URL || '/', fetch: (...args) => fetch(...args),
})
export const { getPlatformSession, waylineFetch, subscribeAuthFailure, logoutPlatformSession } = transport
export async function requirePlatformSession(): Promise<void> { await getPlatformSession() }
