import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createVercelHandler } from '../../api/[...path].js';

describe('Vercel API function adapter', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let refreshCount = 0;

  before(async () => {
    process.env.NODE_ENV = 'development';
    const { app } = await import('../src/app.js');
    const handler = createVercelHandler(async () => ({
      app,
      consentProjection: {
        async refresh() {
          refreshCount += 1;
        },
      },
    }));
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it('passes health and API paths through the existing Express routers', async () => {
    const routes: Array<[string, number]> = [
      ['/api/health', 200],
      ['/api/consents', 200],
      ['/api/files', 403],
      ['/api/approvals', 403],
      ['/api/approvals/status', 200],
      ['/api/ai/status', 200],
      ['/api/consents/demo-actor/audit:read/events', 200],
    ];

    for (const [path, expectedStatus] of routes) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
      });
      assert.equal(response.status, expectedStatus, path);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/, path);
    }
    assert.equal(refreshCount, routes.length);
  });

  it('preserves JSON request bodies and HTTP methods through the function adapter', async () => {
    const response = await fetch(`${baseUrl}/api/consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'files:read' }),
    });
    const body = await response.json() as { status?: { status?: string } };

    assert.equal(response.status, 201);
    assert.equal(body.status?.status, 'granted');
  });

  it('returns a safe JSON error when backend initialization fails', async () => {
    const failingHandler = createVercelHandler(async () => {
      throw new Error('test initialization failure');
    });
    const failingServer = createServer(failingHandler);
    await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
    const failingUrl = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}/api/health`;
    try {
      const response = await fetch(failingUrl);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'Backend services are unavailable; check Supabase configuration and required migrations.',
        code: 'BACKEND_UNAVAILABLE',
      });
    } finally {
      failingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        failingServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
