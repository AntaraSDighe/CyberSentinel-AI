import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditService } from '../src/audit.js';
import { ConsentService } from '../src/consent.js';
import { setupDevelopmentDemoConsents } from '../src/demo-setup.js';
import { ConsentProjection } from '../src/gateway.js';
import { MemoryConsentStore } from '../src/storage.js';

describe('development demo consent setup', () => {
  it('grants approvals:read through consent history once and preserves revocation', async () => {
    const store = new MemoryConsentStore();
    const consent = new ConsentService(store);
    const audit = new AuditService(store);
    const projection = new ConsentProjection(consent);
    await audit.initialize();
    await projection.initialize();

    const first = await setupDevelopmentDemoConsents({ NODE_ENV: 'development' }, consent, audit, projection);
    assert.deepEqual(first.grantedScopes, ['audit:read', 'files:read', 'files:register', 'approvals:read']);
    assert.deepEqual(first.unavailableScopes, []);
    for (const scope of ['audit:read', 'files:read', 'files:register', 'approvals:read']) {
      assert.equal((await consent.status('demo-actor', scope)).status, 'granted');
    }
    assert.equal((await consent.status('demo-actor', 'payments:export')).status, 'missing');
    assert.equal((await audit.list()).length, 4);
    assert.deepEqual(
      await setupDevelopmentDemoConsents({ NODE_ENV: 'development' }, consent, audit, projection),
      { grantedScopes: [], unavailableScopes: [] },
    );

    await consent.revoke('demo-actor', 'approvals:read');
    const afterRevocation = await setupDevelopmentDemoConsents({ NODE_ENV: 'development' }, consent, audit, projection);
    assert.deepEqual(afterRevocation.unavailableScopes, ['approvals:read']);
    assert.equal((await consent.status('demo-actor', 'approvals:read')).status, 'revoked');
    assert.equal(projection.authorize('demo-actor', 'approvals:read').allowed, false);
  });

  it('does not seed any user outside development mode', async () => {
    const store = new MemoryConsentStore();
    const consent = new ConsentService(store);
    const audit = new AuditService(store);
    const projection = new ConsentProjection(consent);
    await audit.initialize();
    await projection.initialize();

    const result = await setupDevelopmentDemoConsents(
      { NODE_ENV: 'production', DEMO_CONSENT_SETUP: 'true' },
      consent, audit, projection,
    );

    assert.deepEqual(result, { grantedScopes: [], unavailableScopes: [] });
    assert.equal((await consent.status('demo-actor', 'audit:read')).status, 'missing');
  });

  it('requires a verified projection and audit chain before recording demo grants', async () => {
    const store = new MemoryConsentStore();
    const consent = new ConsentService(store);
    const audit = new AuditService(store);
    const projection = new ConsentProjection(consent);

    await assert.rejects(
      setupDevelopmentDemoConsents({ NODE_ENV: 'development' }, consent, audit, projection),
      /verified consent projection and audit chain/,
    );
    assert.equal((await consent.status('demo-actor', 'audit:read')).status, 'missing');
  });
});
