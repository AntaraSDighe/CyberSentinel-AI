import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim();
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (mode === 'production') {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for production authentication.');
    }
    let authUrl: URL;
    try {
      authUrl = new URL(supabaseUrl);
    } catch {
      throw new Error('VITE_SUPABASE_URL must be a valid HTTPS Supabase project URL.');
    }
    if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password || authUrl.pathname !== '/') {
      throw new Error('VITE_SUPABASE_URL must be the HTTPS origin of the Supabase project.');
    }
    if (isServiceRoleKey(supabaseAnonKey)) {
      throw new Error('VITE_SUPABASE_ANON_KEY must be the public Supabase key, never a service-role key.');
    }
  }
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

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}