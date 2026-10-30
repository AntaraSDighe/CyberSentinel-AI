import assert from 'node:assert/strict';
import express from 'express';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAuthenticationMiddleware, requireAdministrator } from '../src/authentication.js';
import { createAuthRouter } from '../src/auth-routes.js';
import type { AuthSession, IdentityProvider } from '../src/identity.js';

const session: AuthSession = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresIn: 3600,
  tokenType: 'bearer',
  user: { id: 'auth-user-id', email: 'user@example.com' },
};

function provider(overrides: Partial<IdentityProvider> = {}): IdentityProvider {
  return {
    async signUp() { return session; },
    async signIn() { return session; },
    async refresh() { return session; },
    async verifyAccessToken(token) {
      return token === session.accessToken
        ? { id: session.user.id, email: session.user.email, role: 'user' }
        : null;
    },
    ...overrides,
  };
}

describe('Supabase authentication boundary', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    const identities = provider({
      async verifyAccessToken(token) {
        if (token === 'demo-admin-token') return { id: 'demo-actor', email: null, role: 'admin' };
        if (token === 'admin-token') return { id: 'real-admin-id', email: 'admin@example.com', role: 'admin' };
        return token === session.accessToken
          ? { id: session.user.id, email: session.user.email, role: 'user' }
          : null;
      },
    });
    app.use(createAuthenticationMiddleware(identities, { NODE_ENV: 'production' }));
    app.use('/api/auth', createAuthRouter(identities));
    app.get('/api/consents', (request, response) => response.json({ identity: request.identity }));
    app.get('/api/files', (request, response) => response.json({ identity: request.identity }));
    app.get('/api/approvals', (request, response) => response.json({ identity: request.identity }));
    app.post('/api/approvals/00000000-0000-0000-0000-000000000001/approve', requireAdministrator, (_request, response) => response.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('rejects unauthenticated and invalid-token calls despite client-supplied actor IDs', async () => {
    const missing = await fetch(`${baseUrl}/api/consents?actorId=admin`);
    assert.equal(missing.status, 401);
    const invalid = await fetch(`${baseUrl}/api/consents`, {
      headers: { authorization: 'Bearer invalid-token', 'x-actor-id': 'admin' },
    });
    assert.equal(invalid.status, 401);
  });

  it('derives identity from the verified token rather than client input', async () => {
    const response = await fetch(`${baseUrl}/api/consents?actorId=somebody-else`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      identity: { id: 'auth-user-id', email: 'user@example.com', role: 'user' },
    });
  });

  it('rejects invalid tokens on each protected read API', async () => {
    for (const path of ['/api/consents', '/api/files', '/api/approvals']) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: 'Bearer invalid-token' },
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { code: string }).code, 'AUTH_INVALID');
    }
  });

  it('applies authentication across Express case-insensitive and trailing-slash route variants', async () => {
    for (const path of ['/API/CONSENTS/', '/API/FILES/', '/API/APPROVALS/']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
    }

    const authenticated = await fetch(`${baseUrl}/API/FILES/`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(authenticated.status, 200);
  });

  it('allows only a server-authorized administrator to perform admin actions', async () => {
    const userResponse = await fetch(`${baseUrl}/api/approvals/00000000-0000-0000-0000-000000000001/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(userResponse.status, 403);
    const adminResponse = await fetch(`${baseUrl}/api/approvals/00000000-0000-0000-0000-000000000001/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
    });
    assert.equal(adminResponse.status, 200);
  });

  it('never promotes the demo identity even if a provider returns an administrator role', async () => {
    const demoResponse = await fetch(`${baseUrl}/api/approvals/00000000-0000-0000-0000-000000000001/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-admin-token' },
    });
    assert.equal(demoResponse.status, 403);
    assert.equal((await demoResponse.json() as { code: string }).code, 'ADMIN_REQUIRED');
  });

  it('enables the unauthenticated demo identity only in development and keeps it non-admin', async () => {
    const devApp = express();
    devApp.use(createAuthenticationMiddleware(null, { NODE_ENV: 'development' }));
    devApp.post('/api/approvals/00000000-0000-0000-0000-000000000001/approve', requireAdministrator, (_request, response) => response.json({ ok: true }));
    const devServer = devApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => devServer.once('listening', resolve));
    const address = devServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/approvals/00000000-0000-0000-0000-000000000001/approve`, { method: 'POST' });
      assert.equal(response.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => devServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('limits sign-up credential shape and does not cache session responses', async () => {
    const badCredentials = await fetch(`${baseUrl}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'short' }),
    });
    assert.equal(badCredentials.status, 400);
    const signedIn = await fetch(`${baseUrl}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'long-enough-password' }),
    });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
    assert.equal((await signedIn.json() as { session: AuthSession }).session.accessToken, session.accessToken);
  });
});
