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
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(Number.isFinite(Date.parse(body.timestamp as string)));
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