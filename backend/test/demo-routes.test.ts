import assert from 'node:assert/strict';
import express from 'express';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ApprovalService } from '../src/approvals.js';
import type { ApprovalDelivery } from '../src/approval-delivery.js';
import { AuditService } from '../src/audit.js';
import { createApprovalRouter } from '../src/approval-routes.js';
import { ConsentService } from '../src/consent.js';
import { createConsentRouter } from '../src/consent-routes.js';
import type { ProtectedFileRecord } from '../src/domain.js';
import { ConsentProjection } from '../src/gateway.js';
import { setupDevelopmentDemoConsents } from '../src/demo-setup.js';
import { createAuditRouter } from '../src/audit-routes.js';
import { createFileRouter } from '../src/file-routes.js';
import { ProtectedFileService } from '../src/protected-files.js';
import { MemoryConsentStore } from '../src/storage.js';

const demoActor = 'demo-actor';
const file: ProtectedFileRecord = {
  id: '18a09f0c-f4ab-487d-b41f-895515e7130d',
  actor_id: demoActor,
  name: 'demo.csv',
  size: 12,
  sha256: 'a'.repeat(64),
  content_type: 'text/csv',
  permissions: ['read', 'export'],
  created_at: new Date().toISOString(),
};

describe('development demo route permissions', () => {
  const store = new MemoryConsentStore();
  const consent = new ConsentService(store);
  const projection = new ConsentProjection(consent);
  const audit = new AuditService(store);
  const files = new ProtectedFileService(store, projection, audit);
  let deliveredOtp = '';
  const delivery: ApprovalDelivery = {
    available: true,
    channel: 'development',
    async send(code) { deliveredOtp = code; },
  };
  const approvals = new ApprovalService(
    store, delivery, audit, projection, 'test-secret-with-at-least-32-characters-long',
  );
  const app = express();
  let server: Server;
  let baseUrl: string;

  before(async () => {
    app.use(express.json());
    app.use((request, _response, next) => {
      request.identity = { id: demoActor, email: null, role: 'user' };
      next();
    });
    app.use('/api/consents', createConsentRouter(consent, audit));
    app.use('/api/files', createFileRouter(files, audit, projection));
    app.use('/api/approvals', createApprovalRouter(approvals, files, projection));
    app.use('/api/audit', createAuditRouter(audit, projection));
    await Promise.all([audit.initialize(), projection.initialize()]);
    await setupDevelopmentDemoConsents({ NODE_ENV: 'development' }, consent, audit, projection);
    await store.insertProtectedFile(file);
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

  it('allows the demo actor to read approvals, audit, and file metadata', async () => {
    const approvalsResponse = await fetch(`${baseUrl}/api/approvals?actorId=${demoActor}`);
    const auditResponse = await fetch(`${baseUrl}/api/audit?actorId=${demoActor}`);
    const filesResponse = await fetch(`${baseUrl}/api/files?actorId=${demoActor}`);

    assert.equal(approvalsResponse.status, 200);
    assert.equal(auditResponse.status, 200);
    assert.equal(filesResponse.status, 200);
    assert.deepEqual((await filesResponse.json() as { files: ProtectedFileRecord[] }).files.map((item) => item.id), [file.id]);
  });

  it('allows the demo actor to register metadata using the seeded files:register consent', async () => {
    const response = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'registered-demo.txt',
        size: 12,
        sha256: 'b'.repeat(64),
        contentType: 'text/plain',
        permissions: ['read'],
      }),
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json() as { file: ProtectedFileRecord }).file.actor_id, demoActor);
  });

  it('ignores client-supplied actor IDs and blocks cross-actor path requests', async () => {
    const spoofedList = await fetch(`${baseUrl}/api/files?actorId=other-actor`);
    assert.equal(spoofedList.status, 200);
    assert.deepEqual(new Set((await spoofedList.json() as { files: ProtectedFileRecord[] }).files.map((item) => item.actor_id)), new Set([demoActor]));
    assert.equal((await fetch(`${baseUrl}/api/consents/other-actor/files:read`)).status, 403);

    const exportResponse = await fetch(`${baseUrl}/api/approvals/payment-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId: demoActor, fileId: file.id }),
    });
    assert.equal(exportResponse.status, 403);
    assert.match((await exportResponse.json() as { error: string }).error, /consent_missing/);
    assert.equal(deliveredOtp, '');
    assert.equal((await approvals.list(demoActor)).length, 0);
  });
});
