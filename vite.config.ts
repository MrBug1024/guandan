import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.PORT || 3001);

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
    },
    build: { outDir: 'dist', rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  };
});
