import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    //Proxy API calls so no CORS headers for local dev
    proxy: {
      '/auth':          { target: 'http://localhost:3001', changeOrigin: true },
      '/users':         { target: 'http://localhost:3002', changeOrigin: true },
      '/chat':          { target: 'http://localhost:3003', changeOrigin: true },
      '/notifications': { target: 'http://localhost:3004', changeOrigin: true },
      '/dashboard':     { target: 'http://localhost:3005', changeOrigin: true },
    },
  },
})