import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Trailing slash matters: a bare '/api' prefix would also capture the
      // SPA route /api-dids. Production nginx proxies '/api/' the same way.
      '/api/': {
        // Direct uvicorn default; set VITE_API_PROXY_TARGET=http://localhost:8088
        // to develop against the docker-compose API instead (strips /api like
        // the production nginx does, since the API serves routes at root).
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
        ...(process.env.VITE_API_PROXY_TARGET
          ? { rewrite: (path: string) => path.replace(/^\/api/, '') }
          : {}),
      },
    },
  },
})
