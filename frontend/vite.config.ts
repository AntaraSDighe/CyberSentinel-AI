import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const configuredTarget = env.CYBERSENTINEL_API_URL || `http://127.0.0.1:${process.env.PORT ?? env.PORT ?? '3001'}`;
  const targetUrl = new URL(configuredTarget);
  if (targetUrl.hostname === 'localhost') targetUrl.hostname = '127.0.0.1';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: targetUrl.toString().replace(/\/$/, ''),
          changeOrigin: true,
        },
      },
    },
  };
});