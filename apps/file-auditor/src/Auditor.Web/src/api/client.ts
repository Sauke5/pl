import axios from 'axios';

const path = window.location.pathname;
export const appBase = path === '/audit-arch' || path.startsWith('/audit-arch/')
  ? '/audit-arch'
  : path === '/audit' || path.startsWith('/audit/')
    ? '/audit'
    : '';
export const api = axios.create({ baseURL: `${appBase}/api`, withCredentials: true });
api.interceptors.request.use(async config => {
  if (appBase && !['get', 'head', 'options'].includes((config.method || 'get').toLowerCase())) {
    const response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Войдите в Платформу повторно.');
    const session = await response.json();
    if (!session.authenticated || !session.csrf_token) throw new Error('Войдите в Платформу повторно.');
    config.headers.set('X-CSRF-Token', session.csrf_token);
  }
  return config;
});
