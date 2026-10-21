import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsentService } from '../src/consent.js';
import type { ConsentEvent } from '../src/domain.js';
import { ConsentProjection } from '../src/gateway.js';
import { MemoryConsentStore, type ConsentStore } from '../src/storage.js';

class CountingStore extends MemoryConsentStore {
  reads = 0;

  override async listConsentEvents(actorId?: string): Promise<ConsentEvent[]> {
    this.reads += 1;
    return super.listConsentEvents(actorId);
  }
}

describe('fail-closed consent gateway', () => {
  it('denies authorization until the projection has initialized', () => {
    const projection = new ConsentProjection(new ConsentService(new MemoryConsentStore()));
    assert.equal(projection.authorize('actor-1', 'files:read').reason, 'projection_unavailable');
  });

  it('denies missing consent and performs no storage reads on authorization', async () => {
    const store = new CountingStore();
    const service = new ConsentService(store);
    const projection = new ConsentProjection(service);
    await projection.initialize();
    const readsAfterInitialize = store.reads;

    assert.equal(projection.authorize('actor-1', 'files:read').reason, 'consent_missing');
    assert.equal(projection.authorize('actor-1', 'files:read').allowed, false);
    assert.equal(store.reads, readsAfterInitialize);
  });

  it('updates the in-memory projection as soon as revocation commits', async () => {
    const service = new ConsentService(new MemoryConsentStore());
    const projection = new ConsentProjection(service);
    await projection.initialize();
    await service.grant('actor-1', 'files:read');
    assert.equal(projection.authorize('actor-1', 'files:read').allowed, true);
    await service.revoke('actor-1', 'files:read');
    assert.equal(projection.authorize('actor-1', 'files:read').reason, 'consent_revoked');
  });

  it('denies when the projection exceeds its five-second freshness limit', async () => {
    let clock = Date.now();
    const projection = new ConsentProjection(new ConsentService(new MemoryConsentStore()), 5000, () => clock);
    await projection.initialize();
    clock += 5001;
    assert.equal(projection.authorize('actor-1', 'files:read').reason, 'projection_stale');
  });

  it('reconciles an external revocation in under five seconds with one-second polling', async () => {
    const store = new MemoryConsentStore();
    const service = new ConsentService(store);
    const projection = new ConsentProjection(service);
    await service.grant('actor-1', 'files:read');
    await projection.initialize();
    assert.equal(projection.authorize('actor-1', 'files:read').allowed, true);

    const timer = projection.startPolling(25);
    const before = Date.now();
    await store.appendConsentEvent({
      id: 'external-revoke', actor_id: 'actor-1', scope: 'files:read', event_type: 'REVOKED',
      occurred_at: new Date().toISOString(), expires_at: null,
    });
    try {
      while (projection.authorize('actor-1', 'files:read').allowed && Date.now() - before < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(projection.authorize('actor-1', 'files:read').reason, 'consent_revoked');
      assert.ok(Date.now() - before < 5000);
    } finally {
      clearInterval(timer);
    }
  });

  it('fails closed when an existing event is modified', async () => {
    const mutableStore = new MutableConsentStore();
    const service = new ConsentService(mutableStore);
    const projection = new ConsentProjection(service);
    await service.grant('actor-1', 'files:read');
    await projection.initialize();
    mutableStore.events[0].event_type = 'REVOKED';
    await projection.refresh();
    assert.equal(projection.health().consistent, false);
    assert.equal(projection.authorize('actor-1', 'files:read').reason, 'projection_inconsistent');
  });
});

class MutableConsentStore implements ConsentStore {
  readonly mode = 'test memory';
  events: ConsentEvent[] = [];
  async ensureActor(): Promise<void> {}
  async appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent> {
    this.events.push({ ...event });
    return { ...event };
  }
  async listConsentEvents(actorId?: string): Promise<ConsentEvent[]> {
    return this.events.filter((event) => !actorId || event.actor_id === actorId).map((event) => ({ ...event }));
  }
}