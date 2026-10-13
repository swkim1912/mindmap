import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // KaTeX 포함으로 번들이 크지만 로컬 앱이라 문제없음
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4321' },
  },
});
