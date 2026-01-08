import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 20006,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:20005',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:20005',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})

