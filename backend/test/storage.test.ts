import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createConsentStore, MemoryConsentStore } from '../src/storage.js';

describe('createConsentStore', () => {
  it('uses ephemeral in-memory storage when both Supabase values are absent', () => {
    const store = createConsentStore({});

    assert.ok(store instanceof MemoryConsentStore);
    assert.equal(store.databaseConfigured, false);
  });

  it('refuses to fall back to in-memory storage in production', () => {
    assert.throws(
      () => createConsentStore({ NODE_ENV: 'production' }),
      /Production storage configuration failed: Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required/,
    );
  });

  it('rejects an invalid production database URL instead of falling back', () => {
    assert.throws(
      () => createConsentStore({
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
      }),
      /Production SUPABASE_URL must use HTTPS/,
    );
  });

  it('uses ephemeral storage for partial Supabase configuration with a safe diagnostic', () => {
    const store = createConsentStore({ SUPABASE_URL: 'https://project.supabase.co' });

    assert.ok(store instanceof MemoryConsentStore);
    assert.match(store.configurationError, /Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required/);
    assert.match(store.configurationError, /temporary in-memory storage/);
  });

  it('uses ephemeral storage for an invalid project URL without echoing its value', () => {
    const store = createConsentStore({
      SUPABASE_URL: 'not-a-url-with-sensitive-value',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    });

    assert.ok(store instanceof MemoryConsentStore);
    assert.match(store.configurationError, /SUPABASE_URL must be a valid HTTP\(S\) URL/);
    assert.doesNotMatch(store.configurationError, /sensitive-value/);
  });

  it('uses ephemeral storage for an unrecognized or non-server-side key', () => {
    const store = createConsentStore({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'header.eyJyb2xlIjoiYW5vbiJ9.signature',
    });

    assert.ok(store instanceof MemoryConsentStore);
    assert.match(store.configurationError, /service_role JWT/);
  });

  it('accepts current and legacy Supabase key formats', () => {
    const legacyServiceRoleKey = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
    const secretKeyStore = createConsentStore({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    });
    const legacyServiceRoleStore = createConsentStore({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey,
    });

    assert.equal(secretKeyStore.databaseConfigured, true);
    assert.equal(secretKeyStore.configurationError, null);
    assert.equal(legacyServiceRoleStore.databaseConfigured, true);
  });

  it('uses the public rate-limit RPC contract and verifies it without writing', async () => {
    const calls: Array<{ path: string; profile: string | undefined; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/rest/v1/')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
        return;
      }
      if (request.method === 'POST' && request.url === '/rest/v1/rpc/consume_api_rate_limit') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        calls.push({ path: request.url, profile: request.headers['content-profile'], body });
        if (body.p_bucket_hash === 'invalid') {
          response.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ code: 'P0001', message: 'Invalid rate limit parameters' }));
        } else {
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify([{ allowed: true, retry_after_seconds: 60, remaining: 9 }]));
        }
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const store = createConsentStore({
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    });

    try {
      await store.verifySchema();
      const result = await store.consumeRateLimit('a'.repeat(64), 60, 10);
      assert.deepEqual(result, { allowed: true, retryAfterSeconds: 60, remaining: 9 });
      assert.deepEqual(calls, [
        {
          path: '/rest/v1/rpc/consume_api_rate_limit',
          profile: 'public',
          body: { p_bucket_hash: 'invalid', p_window_seconds: 60, p_maximum: 1 },
        },
        {
          path: '/rest/v1/rpc/consume_api_rate_limit',
          profile: 'public',
          body: { p_bucket_hash: 'a'.repeat(64), p_window_seconds: 60, p_maximum: 10 },
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fails schema verification when PostgREST cannot resolve the shared rate-limit RPC', async () => {
    const server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/rest/v1/')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 'PGRST202', message: 'Function not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const store = createConsentStore({
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    });

    try {
      await assert.rejects(store.verifySchema(), /Could not verify the shared rate-limit function/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});