import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditService, verifyAuditChain } from '../src/audit.js';
import { sha256AuditHash } from '../src/audit-hash.js';
import type { AuditEvent, AuditHead } from '../src/domain.js';
import { MemoryConsentStore, type AuditStore } from '../src/storage.js';

function payload(action: string) {
  return { action, actorId: 'actor-1', resource: 'files:read', operation: 'test', decision: 'recorded' as const, details: { sample: true } };
}

describe('tamper-evident audit chain', () => {
  it('serializes concurrent writes into a verifiable chain', async () => {
    const store = new MemoryConsentStore();
    const audit = new AuditService(store);
    await audit.initialize();
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => audit.record(payload(`event-${index}`))));
    const verification = await audit.verify();
    assert.equal(verification.valid, true);
    assert.equal(verification.eventCount, 24);
    assert.deepEqual(results.map((event) => event.sequence).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1));
  });

  it('detects payload modification and a broken link', () => {
    const first = createEvent(1, null, 'first');
    const second = createEvent(2, first.event_hash, 'second');
    const head = { sequence: 2, last_hash: second.event_hash };
    assert.equal(verifyAuditChain([first, second], head).valid, true);

    const modified = { ...second, payload_text: '{"action":"changed"}' };
    assert.match(verifyAuditChain([first, modified], head).error ?? '', /modified/);
    const broken = { ...second, previous_hash: 'wrong-link' };
    assert.match(verifyAuditChain([first, broken], head).error ?? '', /Broken hash link/);
  });

  it('detects deletion of the final event using the anchored head', async () => {
    const store = new MutableAuditStore();
    const audit = new AuditService(store);
    await audit.initialize();
    await audit.record(payload('first'));
    await audit.record(payload('second'));
    store.events.pop();
    const result = await audit.verify();
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /head does not match/);
  });

  it('rejects missing sequence numbers', () => {
    const first = createEvent(1, null, 'first');
    const second = createEvent(3, first.event_hash, 'third');
    const result = verifyAuditChain([first, second], { sequence: 3, last_hash: second.event_hash });
    assert.match(result.error ?? '', /Missing or reordered/);
  });
});

function createEvent(sequence: number, previousHash: string | null, payloadText: string): AuditEvent {
  return { sequence, payload_text: payloadText, previous_hash: previousHash, event_hash: sha256AuditHash(previousHash, sequence, payloadText) };
}

class MutableAuditStore implements AuditStore {
  readonly mode = 'test memory';
  events: AuditEvent[] = [];
  head: AuditHead | null = null;
  async appendAuditPayload(payloadText: string): Promise<AuditEvent> {
    const previous = this.events.at(-1) ?? null;
    const event = createEvent((previous?.sequence ?? 0) + 1, previous?.event_hash ?? null, payloadText);
    this.events.push(event);
    this.head = { sequence: event.sequence, last_hash: event.event_hash };
    return { ...event };
  }
  async listAuditEvents(): Promise<AuditEvent[]> { return this.events.map((event) => ({ ...event })); }
  async getAuditHead(): Promise<AuditHead | null> { return this.head ? { ...this.head } : null; }
}