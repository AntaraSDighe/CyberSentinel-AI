import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsentConflictError, ConsentService, replayConsent } from '../src/consent.js';
import type { ConsentEvent } from '../src/domain.js';
import { MemoryConsentStore } from '../src/storage.js';

describe('consent event replay', () => {
  it('denies missing consent and replays a grant followed by revocation', async () => {
    const service = new ConsentService(new MemoryConsentStore());
    assert.equal((await service.status('actor-1', 'files:read')).status, 'missing');

    const grant = await service.grant('actor-1', 'files:read');
    assert.equal(grant.event_type, 'GRANTED');
    assert.equal((await service.status('actor-1', 'files:read')).status, 'granted');

    const revoke = await service.revoke('actor-1', 'files:read');
    assert.equal(revoke.event_type, 'REVOKED');
    assert.equal((await service.status('actor-1', 'files:read')).status, 'revoked');
    assert.deepEqual((await service.history('actor-1')).map((event) => event.event_type), ['GRANTED', 'REVOKED']);
  });

  it('does not allow revoking missing consent', async () => {
    const service = new ConsentService(new MemoryConsentStore());
    await assert.rejects(service.revoke('actor-1', 'payments:export'), ConsentConflictError);
  });

  it('replays expired grants as expired and appends explicit expiration events', async () => {
    const expiredGrant: ConsentEvent = {
      id: 'event-1', actor_id: 'actor-1', scope: 'files:read', event_type: 'GRANTED',
      occurred_at: '2026-10-20T00:00:00.000Z', expires_at: '2026-10-20T01:00:00.000Z',
    };
    assert.equal(replayConsent([expiredGrant], 'actor-1', 'files:read').status, 'expired');

    const store = new MemoryConsentStore();
    const service = new ConsentService(store);
    await service.grant('actor-1', 'files:read', new Date(Date.now() + 15).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const expiration = await service.expire('actor-1', 'files:read');
    assert.equal(expiration.event_type, 'EXPIRED');
    assert.equal((await service.status('actor-1', 'files:read')).status, 'expired');
  });

  it('returns event copies so callers cannot mutate stored history', async () => {
    const service = new ConsentService(new MemoryConsentStore());
    const created = await service.grant('actor-1', 'files:read');
    created.event_type = 'REVOKED';
    const [stored] = await service.history();
    assert.equal(stored.event_type, 'GRANTED');
  });
});