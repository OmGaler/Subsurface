import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: './',
    build: {
      chunkSizeWarningLimit: 1200
    },
    define: {
      __TFL_APP_ID__: JSON.stringify(env.TFL_APP_ID ?? ''),
      __TFL_APP_KEY__: JSON.stringify(env.TFL_APP_KEY ?? '')
    },
    test: {
      environment: 'node'
    }
  };
});
