import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { app } from '../src/app.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

describe('GET /api/health', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('returns an OK status, service name, and timestamp', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'cybersentinel-api');
    assert.match(body.storage as string, /in-memory development storage|Supabase PostgreSQL/);
    assert.deepEqual(body.database, {
      configured: false,
      available: false,
      error: 'Supabase credentials are not configured; using temporary in-memory storage; data is lost when the backend restarts',
    });
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(Number.isFinite(Date.parse(body.timestamp as string)));
  });

  it('reports server liveness independently of Supabase and Gemini readiness', async () => {
    const response = await fetch(`${baseUrl}/api/health/live`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'cybersentinel-api');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal('database' in body, false);
    assert.equal('ai' in body, false);
  });

  it('returns an unhealthy status when production storage is not ready', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json() as { status: string };

      assert.equal(response.status, 503);
      assert.equal(body.status, 'unavailable');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('serves dashboard status routes and denies protected reads without consent', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const routes = [
      ['/api/consents?actorId=demo-actor', 200],
      ['/api/files?actorId=demo-actor', 403],
      ['/api/approvals?actorId=demo-actor', 403],
      ['/api/approvals/status', 200],
      ['/api/ai/status', 200],
      ['/api/config/status', 200],
      ['/api/gateway/health', 200],
      ['/api/audit?actorId=demo-actor', 403],
    ] as const;

    try {
      for (const [path, expectedStatus] of routes) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, expectedStatus, path);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/, path);
      }

      const verifyResponse = await fetch(`${baseUrl}/api/audit/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorId: 'demo-actor' }),
      });
      assert.equal(verifyResponse.status, 403);
      assert.equal((await verifyResponse.json() as { reason: string }).reason, 'projection_unavailable');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('reports configuration gaps by variable name only', async () => {
    const response = await fetch(`${baseUrl}/api/config/status`);
    const body = await response.json() as {
      ai: { available: boolean; missingVariableNames: string[] };
      approvals: {
        available: boolean;
        missingVariableNames: string[];
        deliveryRequirementAlternatives: string[][];
      };
    };

    assert.equal(response.status, 200);
    assert.equal(typeof body.ai.available, 'boolean');
    assert.ok(Array.isArray(body.ai.missingVariableNames));
    assert.ok(Array.isArray(body.approvals.missingVariableNames));
    assert.ok(Array.isArray(body.approvals.deliveryRequirementAlternatives));
    assert.doesNotMatch(JSON.stringify(body), /OTP: \d{6}|sk-[A-Za-z0-9]{20,}|password=|secret=/i);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  });

  it('returns a safe JSON error for malformed request bodies', async () => {
    const response = await fetch(`${baseUrl}/api/consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON request body' });
  });
});