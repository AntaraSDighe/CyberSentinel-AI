import type { ConsentEvent, ConsentStatus } from './domain.js';
import { replayConsent, type ConsentService } from './consent.js';

export type GatewayReason = 'allowed' | 'consent_missing' | 'consent_revoked' | 'consent_expired' | 'projection_unavailable' | 'projection_stale' | 'projection_inconsistent';

export interface GatewayDecision {
  allowed: boolean;
  actorId: string;
  scope: string;
  reason: GatewayReason;
  checkedAt: string;
  consentStatus: ConsentStatus['status'] | 'unverifiable';
}

interface ProjectionHealth {
  ready: boolean;
  consistent: boolean;
  lastSyncAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
  error: string | null;
}

export class ConsentProjection {
  private events: ConsentEvent[] = [];
  private statuses = new Map<string, ConsentStatus>();
  private ready = false;
  private consistent = true;
  private lastSyncMs: number | null = null;
  private lastError: string | null = null;
  private localRevision = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly consent: ConsentService,
    private readonly maxAgeMs = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    this.ready = false;
    this.unsubscribe ??= this.consent.onCommitted((event) => this.acceptLocalEvent(event));
    await this.refresh();
  }

  startPolling(intervalMs = 1000): NodeJS.Timeout {
    const timer = setInterval(() => { void this.refresh().catch(() => undefined); }, intervalMs);
    timer.unref();
    return timer;
  }

  async refresh(): Promise<void> {
    const revisionAtStart = this.localRevision;
    try {
      const snapshot = await this.consent.history();
      const existing = new Map(snapshot.map((event) => [event.id, fingerprint(event)]));
      if (existing.size !== snapshot.length || this.events.some((event) => existing.get(event.id) !== fingerprint(event))) {
        this.consistent = false;
        this.ready = false;
        this.lastError = 'Consent history was modified, deleted, or contains duplicate event IDs';
        return;
      }

      const snapshotIds = new Set(snapshot.map((event) => event.id));
      const events = [...snapshot];
      if (this.localRevision !== revisionAtStart) {
        for (const event of this.events) if (!snapshotIds.has(event.id)) events.push(event);
      }
      this.install(events);
      this.consistent = true;
      this.ready = true;
      this.lastSyncMs = this.clock();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Consent history unavailable';
      if (this.lastSyncMs === null || this.clock() - this.lastSyncMs > this.maxAgeMs) this.ready = false;
    }
  }

  authorize(actorId: string, scope: string): GatewayDecision {
    const checkedAt = new Date(this.clock()).toISOString();
    let reason: GatewayReason;
    let consentStatus: GatewayDecision['consentStatus'] = 'unverifiable';
    const age = this.lastSyncMs === null ? null : this.clock() - this.lastSyncMs;

    if (!this.consistent) reason = 'projection_inconsistent';
    else if (!this.ready || this.lastSyncMs === null) reason = 'projection_unavailable';
    else if (age === null || age > this.maxAgeMs) reason = 'projection_stale';
    else {
      const status = this.statuses.get(key(actorId, scope));
      consentStatus = status?.status ?? 'missing';
      if (!status || status.status === 'missing') reason = 'consent_missing';
      else if (status.status === 'revoked') reason = 'consent_revoked';
      else if (status.status === 'expired' || (status.event?.expires_at && Date.parse(status.event.expires_at) <= this.clock())) reason = 'consent_expired';
      else reason = 'allowed';
    }

    return { allowed: reason === 'allowed', actorId, scope, reason, checkedAt, consentStatus };
  }

  health(): ProjectionHealth {
    return {
      ready: this.ready,
      consistent: this.consistent,
      lastSyncAt: this.lastSyncMs === null ? null : new Date(this.lastSyncMs).toISOString(),
      ageMs: this.lastSyncMs === null ? null : Math.max(0, this.clock() - this.lastSyncMs),
      maxAgeMs: this.maxAgeMs,
      error: this.lastError,
    };
  }

  private acceptLocalEvent(event: ConsentEvent): void {
    this.localRevision += 1;
    if (this.events.some((existing) => existing.id === event.id)) {
      this.consistent = false;
      this.ready = false;
      this.lastError = 'Duplicate consent event ID';
      return;
    }
    this.events.push(event);
    try {
      this.install(this.events);
      if (this.ready) this.lastSyncMs = this.clock();
    } catch (error) {
      this.consistent = false;
      this.ready = false;
      this.lastError = error instanceof Error ? error.message : 'Consent projection is inconsistent';
    }
  }

  private install(events: ConsentEvent[]): void {
    const ids = new Set<string>();
    const groups = new Map<string, ConsentEvent[]>();
    for (const event of events) {
      if (ids.has(event.id) || !event.actor_id || !event.scope || !Number.isFinite(Date.parse(event.occurred_at))) {
        throw new Error('Consent history contains invalid or duplicate events');
      }
      ids.add(event.id);
      const subjectKey = key(event.actor_id, event.scope);
      groups.set(subjectKey, [...(groups.get(subjectKey) ?? []), event]);
    }

    const statuses = new Map<string, ConsentStatus>();
    for (const [subjectKey, group] of groups) {
      const [actorId, scope] = subjectKey.split('\u0000');
      const ordered = group.sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
      let previous: ConsentEvent | null = null;
      for (const event of ordered) {
        if (previous && Date.parse(event.occurred_at) < Date.parse(previous.occurred_at)) {
          throw new Error('Consent events are not chronologically ordered');
        }
        if (event.event_type === 'REVOKED' && (!previous || replayConsent([previous], actorId, scope, new Date(Date.parse(event.occurred_at) - 1)).status !== 'granted')) {
          throw new Error('Revocation does not follow an active grant');
        }
        if (event.event_type === 'EXPIRED' && (!previous || previous.event_type !== 'GRANTED' || !previous.expires_at || Date.parse(previous.expires_at) > Date.parse(event.occurred_at))) {
          throw new Error('Expiration does not follow an elapsed grant');
        }
        if (event.event_type !== 'GRANTED' && event.event_type !== 'REVOKED' && event.event_type !== 'EXPIRED') {
          throw new Error('Consent history contains an unknown event type');
        }
        previous = event;
      }
      statuses.set(subjectKey, replayConsent(ordered, actorId, scope, new Date(this.clock())));
    }
    this.events = events.map((event) => ({ ...event }));
    this.statuses = statuses;
  }
}

function key(actorId: string, scope: string): string {
  return `${actorId}\u0000${scope}`;
}

function fingerprint(event: ConsentEvent): string {
  return JSON.stringify([event.id, event.actor_id, event.scope, event.event_type, event.occurred_at, event.expires_at]);
}