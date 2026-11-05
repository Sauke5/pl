import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.AUDITOR_DEV_API_TARGET || 'http://localhost:5000';
const appBase = process.env.AUDITOR_APP_BASE || '/';

export default defineConfig({
  base: appBase.endsWith('/') ? appBase : `${appBase}/`,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
});
