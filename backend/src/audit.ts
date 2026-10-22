import type { AuditEvent, AuditHead, AuditPayload } from './domain.js';
import { canonicalJson, sha256AuditHash } from './audit-hash.js';
import type { AuditStore } from './storage.js';
import { logApiError } from './errors.js';

export interface AuditVerification {
  valid: boolean;
  checkedAt: string;
  eventCount: number;
  lastSequence: number;
  lastHash: string | null;
  error: string | null;
}

export class AuditService {
  private records: AuditEvent[] = [];
  private initialized = false;
  private consistent = true;
  private tail: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(private readonly store: AuditStore) {}

  get storageMode(): string {
    return this.store.mode;
  }

  async initialize(): Promise<AuditVerification> {
    return this.verify();
  }

  async record(payload: Omit<AuditPayload, 'occurredAt'> & { occurredAt?: string }): Promise<AuditEvent> {
    return this.serialized(async () => {
      if (!this.initialized) await this.verify();
      if (!this.consistent) throw new Error(this.lastError ?? 'Audit chain is not verified');
      const normalized: AuditPayload = { ...payload, occurredAt: payload.occurredAt ?? new Date().toISOString() };
      const row = await this.store.appendAuditPayload(canonicalJson(normalized));
      const expected = sha256AuditHash(row.previous_hash, row.sequence, row.payload_text);
      if (row.event_hash !== expected) {
        this.consistent = false;
        this.lastError = 'New audit event hash does not match its payload';
        throw new Error(this.lastError);
      }
      const last = this.records.at(-1);
      if (last && (row.sequence !== last.sequence + 1 || row.previous_hash !== last.event_hash)) {
        const verification = await this.verify();
        if (!verification.valid) throw new Error(verification.error ?? 'Audit chain is inconsistent');
        if (this.records.some((event) => event.sequence === row.sequence && event.event_hash === row.event_hash)) return row;
      }
      this.records.push(row);
      this.initialized = true;
      return row;
    });
  }

  async list(limit = 100): Promise<Array<AuditEvent & { payload: AuditPayload | null }>> {
    const events = await this.store.listAuditEvents();
    return events.slice(-limit).reverse().map((event) => ({ ...event, payload: parsePayload(event.payload_text) }));
  }

  async historyForResource(resource: string, limit = 100): Promise<Array<AuditEvent & { payload: AuditPayload | null }>> {
    const events = await this.store.listAuditEvents();
    return events.slice(-limit).reverse()
      .map((event) => ({ ...event, payload: parsePayload(event.payload_text) }))
      .filter((event) => event.payload?.resource === resource);
  }

  async verify(): Promise<AuditVerification> {
    try {
      const [events, head] = await Promise.all([this.store.listAuditEvents(), this.store.getAuditHead()]);
      const result = verifyAuditChain(events, head);
      this.records = events.map((event) => ({ ...event }));
      this.initialized = result.valid;
      this.consistent = result.valid;
      this.lastError = result.error;
      return result;
    } catch (error) {
      logApiError('audit.verify', error);
      this.initialized = false;
      this.consistent = false;
      this.lastError = 'Audit storage unavailable';
      return {
        valid: false, checkedAt: new Date().toISOString(), eventCount: 0,
        lastSequence: 0, lastHash: null, error: this.lastError,
      };
    }
  }

  health(): { ready: boolean; consistent: boolean; error: string | null } {
    return { ready: this.initialized, consistent: this.consistent, error: this.lastError };
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function verifyAuditChain(events: AuditEvent[], head: AuditHead | null): AuditVerification {
  let previousHash: string | null = null;
  let error: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      error = `Missing or reordered audit event at sequence ${expectedSequence}`;
      break;
    }
    if (event.previous_hash !== previousHash) {
      error = `Broken hash link at sequence ${event.sequence}`;
      break;
    }
    if (event.event_hash !== sha256AuditHash(previousHash, event.sequence, event.payload_text)) {
      error = `Audit payload or hash was modified at sequence ${event.sequence}`;
      break;
    }
    previousHash = event.event_hash;
  }

  if (!error && head && (head.sequence !== events.length || head.last_hash !== previousHash)) {
    error = 'Audit chain head does not match stored events; records may be missing';
  }
  if (!error && !head && events.length > 0) error = 'Audit chain head is missing';
  if (!error && head && events.length === 0) error = 'Audit events are missing from the anchored chain';

  return {
    valid: error === null,
    checkedAt: new Date().toISOString(),
    eventCount: events.length,
    lastSequence: events.at(-1)?.sequence ?? 0,
    lastHash: events.at(-1)?.event_hash ?? null,
    error,
  };
}

function parsePayload(text: string): AuditPayload | null {
  try { return JSON.parse(text) as AuditPayload; } catch { return null; }
}