import { useState, type ReactNode } from 'react';
import { PlatformShell } from '@pl/ui/react';
import '@pl/ui/styles.css';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api, appBase } from '../api/client';
import { dateTime, type Instance } from './shared';
import { usePlatformSession } from './session';

type IconName = 'overview' | 'folders' | 'documents' | 'scans' | 'service' | 'sun' | 'moon' | 'logout' | 'chevron';

const iconPaths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></>,
  folders: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/></>,
  documents: <><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5M8 12h8M8 16h8"/></>,
  scans: <><path d="M4 5h16M4 10h16M4 15h16M4 20h16"/><path d="M7 3v4M7 8v4M7 13v4M7 18v4"/></>,
  service: <><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h7M11 17.5h7"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></>,
  moon: <path d="M20.8 14A9 9 0 0 1 10 3.2 9 9 0 1 0 20.8 14Z"/>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

const navigation: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Обзор', icon: 'overview' },
  { to: '/departments', label: 'Подразделения', icon: 'folders' },
  { to: '/documents', label: 'Документы', icon: 'documents' },
  { to: '/scans', label: 'Сканирования', icon: 'scans' },
  { to: '/service', label: 'О сервисе', icon: 'service' },
];

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [logoutError, setLogoutError] = useState('');
  const instance = useQuery({ queryKey: ['instance'], queryFn: async () => (await api.get<Instance>('/instance')).data, retry: 1 });
  const session = usePlatformSession();
  const otherBase = appBase === '/audit-arch' ? '/audit' : '/audit-arch';
  const other = useQuery({
    queryKey: ['other-instance', otherBase], enabled: Boolean(appBase), retry: false, staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch(`${otherBase}/api/instance`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) return false;
      const result = await response.json() as Instance;
      return typeof result.machineName === 'string' && result.machineName.length <= 128 ? result.machineName : '';
    },
  });
  const machine = instance.data?.machineName || (instance.isError ? 'Сервер не определён' : 'Определяем сервер…');
  const currentSection = navigation.find(x => x.to === location.pathname)?.label || (location.pathname.startsWith('/departments/') ? 'Подразделение' : 'Файловый аудитор');
  const portalUser = session.data?.authenticated ? session.data.user?.name || 'Пользователь Платформы' : null;

  async function logout() {
    if (!session.data?.csrf_token) return;
    setLogoutError('');
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-CSRF-Token': session.data.csrf_token },
      });
      if (!response.ok) throw new Error();
      window.location.assign('/');
    } catch {
      setLogoutError('Не удалось выйти. Повторите действие.');
    }
  }

  return <PlatformShell
    shellClassName="pl-app"
    context=""
    platformHref="/"
    breadcrumbExtra={<span className="auditor-breadcrumb"><Icon name="chevron" size={13}/><Link to="/">Файловый аудитор</Link><Icon name="chevron" size={13}/><b>{currentSection}</b></span>}
    user={portalUser ? { name: portalUser, subtitle: 'Пользователь Платформы' } : undefined}
    onLogout={appBase ? logout : undefined}
    logoutDisabled={!portalUser || !session.data?.csrf_token}
    actions={<span className="header-server">{machine}</span>}
    banner={(logoutError || (appBase && session.isError)) ? <div className="shell-alert" role="alert">{logoutError || 'Не удалось проверить сессию Платформы. Обновите страницу или войдите повторно.'}</div> : null}
    navigation={<>
      <div className="service-title">Файловый аудитор</div>
      <div className="server-context">
        <span>ИСТОЧНИК ДАННЫХ</span>
        <strong>{machine}</strong>
        <small>{instance.data?.latestCompletedScanId ? `Срез №${instance.data.latestCompletedScanId} · ${dateTime(instance.data.latestCompletedScanFinishedAtUtc)}` : 'Срез пока не создан'}</small>
      </div>
      {Boolean(appBase) && <div className="server-switch">
        <span>СЕРВЕРЫ</span>
        <div className="server-current" title="Текущий сервер">{machine} <small>Текущий</small></div>
        {other.data ? <a href={`${otherBase}/`} className="server-other" title="Перейти на другой подключённый сервер">{other.data} <Icon name="chevron" size={16}/></a> : <div className="server-other disabled">Другой сервер <small>Не подключён</small></div>}
      </div>}
      {navigation.map(item => <NavLink key={item.to} end={item.to === '/'} to={item.to} title={item.label} aria-label={item.label} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><Icon name={item.icon}/><span className="nav-label">{item.label}</span></NavLink>)}
    </>}
  >{children}</PlatformShell>;
}
