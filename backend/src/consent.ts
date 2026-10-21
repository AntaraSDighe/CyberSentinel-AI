import { randomUUID } from 'node:crypto';
import type { ConsentEvent, ConsentStatus, ConsentType } from './domain.js';
import type { ConsentStore } from './storage.js';

export function replayConsent(
  events: ConsentEvent[],
  actorId: string,
  scope: string,
  now = new Date(),
): ConsentStatus {
  const matchingEvents = events
    .filter((event) => event.actor_id === actorId && event.scope === scope)
    .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  const latest = matchingEvents.at(-1);

  if (!latest) return { actorId, scope, status: 'missing', event: null };
  if (latest.event_type === 'REVOKED') return { actorId, scope, status: 'revoked', event: latest };
  if (latest.event_type === 'EXPIRED' || (latest.expires_at && Date.parse(latest.expires_at) <= now.getTime())) {
    return { actorId, scope, status: 'expired', event: latest };
  }
  return { actorId, scope, status: 'granted', event: latest };
}

export class ConsentService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: ConsentEvent) => void>();

  constructor(private readonly store: ConsentStore) {}

  get storageMode(): string {
    return this.store.mode;
  }

  async history(actorId?: string): Promise<ConsentEvent[]> {
    return this.store.listConsentEvents(actorId);
  }

  onCommitted(listener: (event: ConsentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(actorId: string, scope: string): Promise<ConsentStatus> {
    return replayConsent(await this.store.listConsentEvents(actorId), actorId, scope);
  }

  async statuses(actorId?: string): Promise<ConsentStatus[]> {
    const events = await this.store.listConsentEvents(actorId);
    const subjects = new Set(events.map((event) => `${event.actor_id}\u0000${event.scope}`));
    return [...subjects].map((subject) => {
      const [subjectActorId, scope] = subject.split('\u0000');
      return replayConsent(events, subjectActorId, scope);
    });
  }

  async grant(actorId: string, scope: string, expiresAt?: string | null): Promise<ConsentEvent> {
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      throw new ConsentInputError('expiresAt must be a future ISO-8601 timestamp');
    }
    return this.withLock(actorId, scope, async () => {
      await this.store.ensureActor(actorId);
      return this.commit({
        id: randomUUID(), actor_id: actorId, scope, event_type: 'GRANTED',
        occurred_at: new Date().toISOString(), expires_at: expiresAt ?? null,
      });
    });
  }

  async revoke(actorId: string, scope: string): Promise<ConsentEvent> {
    return this.withLock(actorId, scope, async () => {
      const current = replayConsent(await this.store.listConsentEvents(actorId), actorId, scope);
      if (current.status !== 'granted') {
        throw new ConsentConflictError(`Cannot revoke consent with status ${current.status}`);
      }
      return this.commit({
        id: randomUUID(), actor_id: actorId, scope, event_type: 'REVOKED',
        occurred_at: new Date().toISOString(), expires_at: null,
      });
    });
  }

  async expire(actorId: string, scope: string): Promise<ConsentEvent> {
    return this.withLock(actorId, scope, async () => {
      const current = replayConsent(await this.store.listConsentEvents(actorId), actorId, scope);
      if (current.status !== 'expired' || current.event?.event_type !== 'GRANTED') {
        throw new ConsentConflictError('Only an elapsed grant can be marked EXPIRED');
      }
      return this.commit({
        id: randomUUID(), actor_id: actorId, scope, event_type: 'EXPIRED',
        occurred_at: new Date().toISOString(), expires_at: null,
      });
    });
  }

  private async withLock<T>(actorId: string, scope: string, operation: () => Promise<T>): Promise<T> {
    const key = `${actorId}\u0000${scope}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  private async commit(event: ConsentEvent): Promise<ConsentEvent> {
    const persisted = await this.store.appendConsentEvent(event);
    for (const listener of this.listeners) listener({ ...persisted });
    return persisted;
  }
}

export class ConsentInputError extends Error {}
export class ConsentConflictError extends Error {}

export type ConsentEventType = ConsentType;