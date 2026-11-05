import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  cacheDir: process.env.PORTAL_VITE_CACHE_DIR || "node_modules/.vite",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: process.env.PORTAL_API_URL || "http://127.0.0.1:8080",
        changeOrigin: false,
      },
      "/auth": {
        target: process.env.PORTAL_API_URL || "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
});
