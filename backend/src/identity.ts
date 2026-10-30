import { createClient } from '@supabase/supabase-js';
import type { ApplicationStore } from './storage.js';

export type UserRole = 'user' | 'admin';

export interface AuthenticatedIdentity {
  id: string;
  email: string | null;
  role: UserRole;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string | null };
}

export interface IdentityProvider {
  signUp(email: string, password: string): Promise<AuthSession | null>;
  signIn(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  verifyAccessToken(accessToken: string): Promise<AuthenticatedIdentity | null>;
}

export class SupabaseIdentityProvider implements IdentityProvider {
  private readonly publicClient;
  private readonly serviceClient;

  constructor(
    url: string,
    anonKey: string,
    serviceRoleKey: string,
    private readonly store: ApplicationStore,
  ) {
    const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
    this.publicClient = createClient(url, anonKey, { auth: authOptions });
    this.serviceClient = createClient(url, serviceRoleKey, { auth: authOptions });
  }

  async signUp(email: string, password: string): Promise<AuthSession | null> {
    const { data, error } = await this.publicClient.auth.signUp({ email, password });
    if (error) throw error;
    return data.session ? toSession(data.session) : null;
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await this.publicClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.session) throw new Error('Supabase Auth returned no session');
    return toSession(data.session);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await this.publicClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error;
    if (!data.session) throw new Error('Supabase Auth returned no refreshed session');
    return toSession(data.session);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthenticatedIdentity | null> {
    const { data, error } = await this.serviceClient.auth.getUser(accessToken);
    if (error) {
      if (error.status === 401 || error.status === 403) return null;
      throw error;
    }
    if (!data.user) return null;

    const role = data.user.id === 'demo-actor' ? 'user' : await this.store.getActorRole(data.user.id);
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      role: role === 'admin' && data.user.id !== 'demo-actor' ? 'admin' : 'user',
    };
  }
}

export function createIdentityProvider(
  env: NodeJS.ProcessEnv,
  store: ApplicationStore,
): IdentityProvider | null {
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anonKey || !serviceRoleKey) return null;
  return new SupabaseIdentityProvider(url, anonKey, serviceRoleKey, store);
}

function toSession(session: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: { id: string; email?: string };
}): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    tokenType: session.token_type,
    user: { id: session.user.id, email: session.user.email ?? null },
  };
}
