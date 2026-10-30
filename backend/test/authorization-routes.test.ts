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
import { createAuditRouter } from '../src/audit-routes.js';
import { createFileRouter } from '../src/file-routes.js';
import { ProtectedFileService } from '../src/protected-files.js';
import { createRateLimitMiddleware } from '../src/rate-limits.js';
import { MemoryConsentStore } from '../src/storage.js';

const actorId = 'demo-actor';
const adminOtpSecret = 'test-only-otp-secret-that-is-at-least-32-characters';
let deliveredOtp = '';
const protectedFile: ProtectedFileRecord = {
  id: '7d400ceb-c0f3-4d33-8755-e3c87dc1a152',
  actor_id: actorId,
  name: 'record.csv',
  size: 8,
  sha256: 'a'.repeat(64),
  content_type: 'text/csv',
  permissions: ['read', 'export'],
  created_at: new Date().toISOString(),
};

describe('authorization route policies', () => {
  const store = new MemoryConsentStore();
  const consent = new ConsentService(store);
  const projection = new ConsentProjection(consent);
  const audit = new AuditService(store);
  const files = new ProtectedFileService(store, projection, audit);
  const delivery: ApprovalDelivery = {
    available: true,
    channel: 'smtp',
    async send(code) { deliveredOtp = code; },
  };
  const approvals = new ApprovalService(store, delivery, audit, projection, adminOtpSecret, () => Date.now());
  const app = express();
  let server: Server;
  let baseUrl: string;

  before(async () => {
    app.use(express.json());
    app.use(createRateLimitMiddleware(store, 'authorization-route-test-secret-longer-than-32-characters', 'ip'));
    app.use((request, _response, next) => {
      request.identity = {
        id: request.get('x-test-role') === 'admin' ? 'real-admin' : actorId,
        email: null,
        role: request.get('x-test-role') === 'admin' ? 'admin' : 'user',
      };
      next();
    });
    app.use(createRateLimitMiddleware(store, 'authorization-route-test-secret-longer-than-32-characters', 'identity'));
    app.use('/api/consents', createConsentRouter(consent, audit));
    app.use('/api/files', createFileRouter(files, audit, projection));
    app.use('/api/approvals', createApprovalRouter(approvals, files, projection));
    app.use('/api/audit', createAuditRouter(audit, projection));
    await Promise.all([audit.initialize(), projection.initialize()]);
    await store.insertProtectedFile(protectedFile);
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

  it('denies file metadata listing without files:read consent and lists only after a grant', async () => {
    const denied = await fetch(`${baseUrl}/api/files?actorId=${actorId}`);
    const denial = await denied.json() as { scope: string; reason: string; actorId: string };
    assert.equal(denied.status, 403);
    assert.deepEqual({ scope: denial.scope, reason: denial.reason, actorId: denial.actorId }, {
      scope: 'files:read', reason: 'consent_missing', actorId,
    });

    const grant = await fetch(`${baseUrl}/api/consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId, scope: 'files:read' }),
    });
    assert.equal(grant.status, 201);

    const allowed = await fetch(`${baseUrl}/api/files?actorId=${actorId}`);
    assert.equal(allowed.status, 200);
    assert.deepEqual((await allowed.json() as { files: ProtectedFileRecord[] }).files.map((file) => file.id), [protectedFile.id]);

    const revoked = await fetch(`${baseUrl}/api/consents/${actorId}/files:read/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 201);
    const deniedAfterRevocation = await fetch(`${baseUrl}/api/files`);
    assert.equal(deniedAfterRevocation.status, 403);
    assert.equal((await deniedAfterRevocation.json() as { reason: string }).reason, 'consent_revoked');
  });

  it('requires approvals:read to list only the requesting actor’s approvals', async () => {
    const denied = await fetch(`${baseUrl}/api/approvals?actorId=${actorId}`);
    const denial = await denied.json() as { scope: string; reason: string; actorId: string };
    assert.equal(denied.status, 403);
    assert.deepEqual({ scope: denial.scope, reason: denial.reason, actorId: denial.actorId }, {
      scope: 'approvals:read', reason: 'consent_missing', actorId,
    });

    const deniedExport = await fetch(`${baseUrl}/api/approvals/payment-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId, fileId: protectedFile.id }),
    });
    assert.equal(deniedExport.status, 403);
    assert.match((await deniedExport.json() as { error: string }).error, /consent_missing/);

    for (const scope of ['approvals:read', 'payments:export']) {
      const grant = await fetch(`${baseUrl}/api/consents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorId, scope }),
      });
      assert.equal(grant.status, 201);
    }

    const created = await fetch(`${baseUrl}/api/approvals/payment-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId, fileId: protectedFile.id }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { request: { id: string; otp?: string; otp_hash?: string } };
    assert.equal('otp' in createdBody.request, false);
    assert.equal('otp_hash' in createdBody.request, false);
    assert.equal(JSON.stringify(createdBody).includes(deliveredOtp), false);
    const allowed = await fetch(`${baseUrl}/api/approvals?actorId=${actorId}`);
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as { requests: Array<{ actor_id: string; otp_hash?: string }> };
    assert.equal(body.requests.length, 1);
    assert.equal(body.requests[0].actor_id, actorId);
    assert.equal('otp_hash' in body.requests[0], false);
  });

  it('lists only the authenticated actor’s consent history', async () => {
    await consent.grant(actorId, 'profile:read');
    await consent.grant('different-actor', 'audit:read');

    const response = await fetch(`${baseUrl}/api/consents?actorId=different-actor`);
    assert.equal(response.status, 200);
    const body = await response.json() as { consents: Array<{ actorId: string; scope: string }> };
    assert.ok(body.consents.some((item) => item.actorId === actorId && item.scope === 'profile:read'));
    assert.ok(body.consents.every((item) => item.actorId === actorId));
  });

  it('requires a valid administrator-delivered OTP to approve a request', async () => {
    const requests = await approvals.list(actorId);
    const pending = requests.find((request) => request.status === 'pending');
    assert.ok(pending);

    const unauthorized = await fetch(`${baseUrl}/api/approvals/${pending.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ otp: '000000' }),
    });
    assert.equal(unauthorized.status, 403);

    const authorized = await fetch(`${baseUrl}/api/approvals/${pending.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({ otp: deliveredOtp }),
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json() as { request: { status: string } }).request.status, 'approved');
  });

  it('requires audit:read and verifies the stored hash chain before reporting success', async () => {
    const denied = await fetch(`${baseUrl}/api/audit/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId }),
    });
    assert.equal(denied.status, 403);

    await consent.grant(actorId, 'audit:read');
    const response = await fetch(`${baseUrl}/api/audit/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { valid: boolean; storageAvailable: boolean };
    assert.equal(result.storageAvailable, true);
    assert.equal(result.valid, true);
  });

  it('reports an audit-chain integrity failure without treating the chain as valid', async () => {
    const listAuditEvents = store.listAuditEvents.bind(store);
    store.listAuditEvents = async () => {
      const events = await listAuditEvents();
      return events[0] ? [{ ...events[0], payload_text: `${events[0].payload_text} ` }, ...events.slice(1)] : events;
    };

    const response = await fetch(`${baseUrl}/api/audit/verify`, { method: 'POST' });
    assert.equal(response.status, 409);
    const result = await response.json() as { valid: boolean; error: string };
    assert.equal(result.valid, false);
    assert.match(result.error, /modified/);
  });
});
