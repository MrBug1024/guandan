import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  server: { hmr: { host: '127.0.0.1' }, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { outDir: 'dist', rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
