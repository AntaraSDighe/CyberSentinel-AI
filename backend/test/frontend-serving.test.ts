import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFrontendHandler } from '../src/frontend-serving.js';

describe('production frontend handler', () => {
  let directory: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cybersentinel-frontend-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<main>CyberSentinel</main>');
    await writeFile(join(directory, 'assets', 'app.js'), 'window.cybersentinel = true;');

    const app = express();
    app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
    app.use(createFrontendHandler(directory));
    app.use('/api', (_request, response) => response.status(404).json({ error: 'Not found' }));
    app.use((_request, response) => response.status(404).send('Not found'));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  });

  it('serves static assets and the SPA entry point for frontend routes', async () => {
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    const route = await fetch(`${baseUrl}/consent-management`, {
      headers: { accept: 'text/html' },
    });

    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await asset.text(), 'window.cybersentinel = true;');
    assert.equal(route.status, 200);
    assert.match(await route.text(), /CyberSentinel/);
  });

  it('does not let SPA fallback intercept API paths', async () => {
    const knownApi = await fetch(`${baseUrl}/api/health`, {
      headers: { accept: 'text/html' },
    });
    const unknownApi = await fetch(`${baseUrl}/api/missing`, {
      headers: { accept: 'text/html' },
    });

    assert.equal(knownApi.status, 200);
    assert.match(knownApi.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(await unknownApi.json(), { error: 'Not found' });
  });
});
