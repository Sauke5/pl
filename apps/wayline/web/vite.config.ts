import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || env.WAYLINE_BASE_PATH || '/'
  if (!['/', '/wayline/'].includes(base)) throw new Error('VITE_BASE_PATH должен быть / или /wayline/.')
  if (env.VITE_PLATFORM_AUTH === 'true' && base !== '/wayline/') {
    throw new Error('Авторизация платформы требует VITE_BASE_PATH=/wayline/.')
  }
  const ecosystem = env.VITE_PLATFORM_AUTH === 'true' ? '/ecosystem/' : `${base}assets/ecosystem/`
  return { base, plugins: [{
    name: 'wayline-own-origin-themes',
    transformIndexHtml(html) {
      return html.replace('<!-- PL_THEME_BOOTSTRAP -->', `<script src="${ecosystem}theme-catalog.js"></script><script src="${ecosystem}theme-runtime.js"></script><link rel="stylesheet" href="${ecosystem}theme-menu.css">`)
    },
  }] }
})
