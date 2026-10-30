import assert from 'node:assert/strict';
import express from 'express';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createCorsMiddleware } from '../src/cors.js';

describe('production CORS policy', () => {
  const app = express();
  const sameOriginApp = express();
  let server: Server;
  let sameOriginServer: Server;
  let baseUrl: string;
  let sameOriginBaseUrl: string;

  before(async () => {
    app.use(createCorsMiddleware({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://cybersentinel.example',
    }));
    app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
    sameOriginApp.use(createCorsMiddleware({ NODE_ENV: 'production' }));
    sameOriginApp.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => {
      sameOriginServer = sameOriginApp.listen(0, '127.0.0.1', resolve);
    });
    sameOriginBaseUrl = `http://127.0.0.1:${(sameOriginServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await Promise.all([server, sameOriginServer].map((currentServer) => new Promise<void>((resolve, reject) => {
      currentServer.close((error) => error ? reject(error) : resolve());
    })));
  });

  it('allows the configured frontend and same-service origins only', async () => {
    const allowed = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: 'https://cybersentinel.example' },
    });
    const sameOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: baseUrl },
    });
    const denied = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: 'https://attacker.example' },
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://cybersentinel.example');
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), baseUrl);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  it('answers preflight for the approved origin only', async () => {
    const allowed = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://cybersentinel.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    const denied = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example' },
    });

    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(allowed.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
    assert.equal(denied.status, 403);
  });

  it('keeps non-browser API health checks available without an Origin header', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('allows the exact request origin for single-origin production hosting', async () => {
    const allowed = await fetch(`${sameOriginBaseUrl}/api/health`, {
      headers: { origin: sameOriginBaseUrl },
    });
    const denied = await fetch(`${sameOriginBaseUrl}/api/health`, {
      headers: { origin: 'https://attacker.example' },
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), sameOriginBaseUrl);
    assert.equal(denied.status, 403);
  });
});
