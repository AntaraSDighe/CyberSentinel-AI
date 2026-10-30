import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabaseAuthClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  })
  : null;

export const developmentDemoEnabled = import.meta.env.DEV && import.meta.env.VITE_DEMO_AUTH !== 'false';

export async function getAccessToken(): Promise<string | null> {
  if (!supabaseAuthClient) return null;
  const { data, error } = await supabaseAuthClient.auth.getSession();
  if (error) throw new Error('Could not read the current sign-in session.');
  return data.session?.access_token ?? null;
}
