import assert from 'node:assert/strict';
import express from 'express';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRateLimitMiddleware, rateLimitStorageFailure } from '../src/rate-limits.js';
import { MemoryConsentStore } from '../src/storage.js';

const secret = 'rate-limit-test-secret-with-at-least-32-characters';

describe('shared rate limiting', () => {
  const memoryStore = new MemoryConsentStore();
  let now = 1_000_000;
  const store = {
    consumeRateLimit: (bucketHash: string, windowSeconds: number, maximum: number) =>
      memoryStore.consumeRateLimit(bucketHash, windowSeconds, maximum, now),
  };
  const app = express();
  let server: Server;
  let baseUrl: string;
  let analyzed = 0;
  let signedIn = 0;

  before(async () => {
    app.use(express.json());
    app.use((request, _response, next) => {
      request.identity = { id: 'rate-test-actor', email: null, role: 'user' };
      next();
    });
    app.use(createRateLimitMiddleware(store, secret, 'ip'));
    app.use(createRateLimitMiddleware(store, secret, 'identity'));
    app.post('/api/ai/analyze', (_request, response) => {
      analyzed += 1;
      response.json({ ok: true });
    });
    app.post('/api/auth/sign-in', (_request, response) => {
      signedIn += 1;
      response.json({ ok: true });
    });
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

  it('returns HTTP 429 for repeated AI analysis and resets after the shared window', async () => {
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await fetch(`${baseUrl}/api/ai/analyze`, { method: 'POST' })).status, 200);
    }
    const limited = await fetch(`${baseUrl}/api/ai/analyze`, { method: 'POST' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await limited.json() as { code: string }).code, 'RATE_LIMITED');
    assert.equal(analyzed, 10);

    now += 60_000;
    assert.equal((await fetch(`${baseUrl}/api/ai/analyze`, { method: 'POST' })).status, 200);
    assert.equal(analyzed, 11);
  });

  it('enforces a shared actor bucket for concurrent API requests', async () => {
    const concurrentApp = express();
    concurrentApp.use((request, _response, next) => {
      request.identity = { id: 'concurrent-test-actor', email: null, role: 'user' };
      next();
    });
    concurrentApp.use(createRateLimitMiddleware(store, secret, 'identity'));
    concurrentApp.post('/api/ai/analyze', (_request, response) => response.sendStatus(204));
    const concurrentServer = concurrentApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => concurrentServer.once('listening', resolve));
    const address = concurrentServer.address() as AddressInfo;

    try {
      const responses = await Promise.all(Array.from({ length: 12 }, () =>
        fetch(`http://127.0.0.1:${address.port}/api/ai/analyze`, { method: 'POST' })));
      assert.equal(responses.filter((response) => response.status === 204).length, 10);
      assert.equal(responses.filter((response) => response.status === 429).length, 2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        concurrentServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('applies account and IP limits to unauthenticated sign-in requests', async () => {
    let response: Response | undefined;
    for (let index = 0; index < 6; index += 1) {
      const path = index % 2 === 0 ? '/api/auth/sign-in/' : '/API/AUTH/SIGN-IN';
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'limited@example.com' }),
      });
    }
    assert.equal(response?.status, 429);
    assert.equal((await response?.json() as { code: string }).code, 'RATE_LIMITED');
    assert.equal(signedIn, 5);
  });

  it('fails closed if the shared persistence layer is unavailable', async () => {
    const failingApp = express();
    failingApp.use(createRateLimitMiddleware({
      async consumeRateLimit() {
        throw Object.assign(new Error('Could not find function; do not expose this provider text'), {
          code: 'PGRST202',
          status: 404,
        });
      },
    }, secret));
    failingApp.get('/api/sensitive', (_request, response) => response.json({ ok: true }));
    const failingServer = failingApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => failingServer.once('listening', resolve));
    const address = failingServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sensitive`);
      assert.equal(response.status, 503);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, 'RATE_LIMIT_RPC_NOT_FOUND');
      assert.match(body.error, /public\.consume_api_rate_limit/);
      assert.doesNotMatch(body.error, /provider text/);
    } finally {
      await new Promise<void>((resolve, reject) => failingServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('distinguishes database permission failures without exposing provider messages', () => {
    const failure = rateLimitStorageFailure(Object.assign(
      new Error('sensitive backend details'),
      { code: '42501', status: 403 },
    ));

    assert.equal(failure.code, 'RATE_LIMIT_STORAGE_PERMISSION_DENIED');
    assert.equal(failure.diagnosticCode, '42501');
    assert.equal(failure.status, 403);
    assert.doesNotMatch(failure.message, /sensitive backend details/);
  });

  it('distinguishes an unexposed PostgREST schema and ambiguous RPC overloads', () => {
    assert.equal(
      rateLimitStorageFailure(Object.assign(new Error('details'), { code: 'PGRST106', status: 406 })).code,
      'RATE_LIMIT_SCHEMA_NOT_EXPOSED',
    );
    assert.equal(
      rateLimitStorageFailure(Object.assign(new Error('details'), { code: 'PGRST203', status: 300 })).code,
      'RATE_LIMIT_RPC_AMBIGUOUS',
    );
  });

  it('resets the persistent-store contract at the exact window boundary', async () => {
    const bucket = 'f'.repeat(64);
    assert.equal((await memoryStore.consumeRateLimit(bucket, 10, 2, 5_000)).allowed, true);
    assert.equal((await memoryStore.consumeRateLimit(bucket, 10, 2, 6_000)).allowed, true);
    assert.equal((await memoryStore.consumeRateLimit(bucket, 10, 2, 7_000)).allowed, false);
    assert.equal((await memoryStore.consumeRateLimit(bucket, 10, 2, 15_000)).allowed, true);
  });
});
