import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApprovalDeniedError, ApprovalService, ApprovalUnavailableError } from '../src/approvals.js';
import type { ApprovalDelivery } from '../src/approval-delivery.js';
import { AuditService } from '../src/audit.js';
import { ConsentService } from '../src/consent.js';
import type { ProtectedFileRecord } from '../src/domain.js';
import { ConsentProjection } from '../src/gateway.js';
import { MemoryConsentStore } from '../src/storage.js';

const otpSecret = 'test-secret-with-at-least-32-characters-long';

function harness(options: { available?: boolean; now?: number } = {}) {
  let now = options.now ?? Date.now();
  let deliveredCode = '';
  const delivery: ApprovalDelivery = {
    available: options.available ?? true,
    channel: options.available === false ? null : 'smtp',
    async send(code) { deliveredCode = code; },
  };
  const store = new MemoryConsentStore();
  const consent = new ConsentService(store);
  const audit = new AuditService(store);
  const projection = new ConsentProjection(consent, 5000, () => now);
  const approvals = new ApprovalService(store, delivery, audit, projection, otpSecret, () => now);
  const file: ProtectedFileRecord = {
    id: '8ee39e86-a489-462c-a092-115c9994bc95', actor_id: 'actor-1', name: 'payroll.csv',
    size: 42, sha256: 'a'.repeat(64), content_type: 'text/csv', permissions: ['read', 'export'], created_at: new Date(now).toISOString(),
  };
  return {
    store, consent, audit, projection, approvals, file,
    get deliveredCode() { return deliveredCode; },
    advance(milliseconds: number) { now += milliseconds; },
  };
}

async function initialize(h: ReturnType<typeof harness>) {
  await h.audit.initialize();
  await h.consent.grant('actor-1', 'payments:export');
  await h.projection.initialize();
  await h.store.insertProtectedFile(h.file);
}

describe('administrator approvals', () => {
  it('fails closed when OTP delivery is unavailable', async () => {
    const h = harness({ available: false });
    await initialize(h);
    await assert.rejects(h.approvals.requestExport('actor-1', h.file), ApprovalUnavailableError);
    assert.equal((await h.approvals.list()).length, 0);
  });

  it('keeps the OTP server-side and requires the correct code before release', async () => {
    const h = harness();
    await initialize(h);
    const request = await h.approvals.requestExport('actor-1', h.file);
    assert.equal('otp_hash' in request, false);
    assert.equal('otp' in request, false);
    assert.match(h.deliveredCode, /^\d{6}$/);

    await assert.rejects(h.approvals.approve(request.id, '000000'), ApprovalDeniedError);
    await h.approvals.approve(request.id, h.deliveredCode);
    const exported = await h.approvals.release(request.id, 'actor-1', async () => h.file);
    assert.equal(exported.sha256, h.file.sha256);
    await assert.rejects(h.approvals.release(request.id, 'actor-1', async () => h.file), ApprovalDeniedError);
  });

  it('rechecks consent after administrator approval and before release', async () => {
    const h = harness();
    await initialize(h);
    const request = await h.approvals.requestExport('actor-1', h.file);
    await h.approvals.approve(request.id, h.deliveredCode);
    await h.consent.revoke('actor-1', 'payments:export');
    await assert.rejects(h.approvals.release(request.id, 'actor-1', async () => h.file), /Consent recheck denied/);
  });

  it('automatically expires pending approvals after 60 seconds', async () => {
    const h = harness();
    await initialize(h);
    const request = await h.approvals.requestExport('actor-1', h.file);
    h.advance(60_001);
    const [expired] = await h.approvals.list('actor-1');
    assert.equal(expired.id, request.id);
    assert.equal(expired.status, 'expired');
    await assert.rejects(h.approvals.approve(request.id, h.deliveredCode), ApprovalDeniedError);
  });

  it('does not release when the OTP secret is missing', async () => {
    const h = harness();
    const service = new ApprovalService(h.store, { available: true, channel: 'smtp', async send() {} }, h.audit, h.projection, 'short');
    await initialize(h);
    await assert.rejects(service.requestExport('actor-1', h.file), ApprovalUnavailableError);
  });
});