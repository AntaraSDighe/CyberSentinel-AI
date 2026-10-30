import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApprovalRequest, AuditEvent, AuditHead, ConsentEvent, ProtectedFileRecord } from './domain.js';
import { sha256AuditHash } from './audit-hash.js';

export interface ConsentStore {
  readonly mode: string;
  ensureActor(actorId: string): Promise<void>;
  appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent>;
  listConsentEvents(actorId?: string): Promise<ConsentEvent[]>;
}

export interface AuditStore {
  readonly mode: string;
  appendAuditPayload(payloadText: string): Promise<AuditEvent>;
  listAuditEvents(): Promise<AuditEvent[]>;
  getAuditHead(): Promise<AuditHead | null>;
}

export interface PlatformStore extends ConsentStore, AuditStore {}

export interface ProtectedDataStore {
  readonly mode: string;
  insertProtectedFile(file: ProtectedFileRecord): Promise<ProtectedFileRecord>;
  getProtectedFile(id: string): Promise<ProtectedFileRecord | null>;
  listProtectedFiles(actorId?: string): Promise<ProtectedFileRecord[]>;
  insertApproval(request: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  listApprovals(actorId?: string): Promise<ApprovalRequest[]>;
  updateApproval(request: ApprovalRequest): Promise<ApprovalRequest>;
}

export interface ApplicationStore extends PlatformStore, ProtectedDataStore {
  readonly databaseConfigured: boolean;
  readonly configurationError: string | null;
  getActorRole(actorId: string): Promise<string | null>;
  consumeRateLimit(bucketHash: string, windowSeconds: number, maximum: number): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
    remaining: number;
  }>;
  verifySchema(): Promise<void>;
}

export class MemoryConsentStore implements ApplicationStore {
  readonly databaseConfigured = false;
  readonly mode = 'in-memory development storage (ephemeral; data is lost on restart)';
  readonly configurationError: string;
  private readonly events: ConsentEvent[] = [];
  private readonly auditEvents: AuditEvent[] = [];
  private readonly files = new Map<string, ProtectedFileRecord>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly actors = new Set<string>();
  private readonly rateLimitBuckets = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(configurationError = 'Supabase credentials are not configured') {
    this.configurationError = `${configurationError}; using temporary in-memory storage; data is lost when the backend restarts`;
  }

  async verifySchema(): Promise<void> {}

  async ensureActor(actorId: string): Promise<void> {
    this.actors.add(actorId);
  }

  async getActorRole(actorId: string): Promise<string | null> {
    return this.actors.has(actorId) ? 'user' : null;
  }

  async consumeRateLimit(
    bucketHash: string,
    windowSeconds: number,
    maximum: number,
    now = Date.now(),
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }> {
    const windowMs = windowSeconds * 1000;
    const bucket = this.rateLimitBuckets.get(bucketHash);
    const current = !bucket || now - bucket.windowStartedAt >= windowMs
      ? { windowStartedAt: now, count: 1 }
      : { ...bucket, count: Math.min(bucket.count + 1, maximum + 1) };
    this.rateLimitBuckets.set(bucketHash, current);
    return {
      allowed: current.count <= maximum,
      retryAfterSeconds: Math.max(1, Math.ceil((current.windowStartedAt + windowMs - now) / 1000)),
      remaining: Math.max(0, maximum - current.count),
    };
  }

  async appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent> {
    this.events.push({ ...event });
    return { ...event };
  }

  async listConsentEvents(actorId?: string): Promise<ConsentEvent[]> {
    return this.events
      .filter((event) => !actorId || event.actor_id === actorId)
      .map((event) => ({ ...event }));
  }

  async appendAuditPayload(payloadText: string): Promise<AuditEvent> {
    const previous = this.auditEvents.at(-1) ?? null;
    const sequence = (previous?.sequence ?? 0) + 1;
    const event: AuditEvent = {
      sequence,
      payload_text: payloadText,
      previous_hash: previous?.event_hash ?? null,
      event_hash: sha256AuditHash(previous?.event_hash ?? null, sequence, payloadText),
    };
    this.auditEvents.push(event);
    return { ...event };
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    return this.auditEvents.map((event) => ({ ...event }));
  }

  async getAuditHead(): Promise<AuditHead | null> {
    const latest = this.auditEvents.at(-1);
    return latest ? { sequence: latest.sequence, last_hash: latest.event_hash } : null;
  }

  async insertProtectedFile(file: ProtectedFileRecord): Promise<ProtectedFileRecord> {
    this.files.set(file.id, { ...file, permissions: [...file.permissions] });
    return cloneFile(file);
  }

  async getProtectedFile(id: string): Promise<ProtectedFileRecord | null> {
    const file = this.files.get(id);
    return file ? cloneFile(file) : null;
  }

  async listProtectedFiles(actorId?: string): Promise<ProtectedFileRecord[]> {
    return [...this.files.values()].filter((file) => !actorId || file.actor_id === actorId).map(cloneFile);
  }

  async insertApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.approvals.set(request.id, { ...request });
    return { ...request };
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const request = this.approvals.get(id);
    return request ? { ...request } : null;
  }

  async listApprovals(actorId?: string): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()].filter((request) => !actorId || request.actor_id === actorId).map((request) => ({ ...request }));
  }

  async updateApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    if (!this.approvals.has(request.id)) throw new Error('Approval request not found');
    this.approvals.set(request.id, { ...request });
    return { ...request };
  }
}

class SupabaseConsentStore implements ApplicationStore {
  readonly databaseConfigured = true;
  readonly mode = 'Supabase PostgreSQL';
  readonly configurationError = null;

  constructor(private readonly client: SupabaseClient<any>) {}

  async verifySchema(): Promise<void> {
    const tables = [
      'actor_profiles',
      'consent_events',
      'audit_events',
      'audit_chain_heads',
      'protected_files',
      'approval_requests',
      'api_rate_limit_buckets',
    ];
    for (const table of tables) {
      const result = await this.client.from(table).select('*').limit(0);
      if (result.error) {
        throwSupabaseError(`Could not verify the ${table} table; apply all Supabase migrations`, result.error, result.status);
      }
    }

    const rateLimitProbe = await this.client.rpc('consume_api_rate_limit', {
      p_bucket_hash: 'invalid',
      p_window_seconds: 60,
      p_maximum: 1,
    });
    if (rateLimitProbe.error?.code !== 'P0001' ||
      rateLimitProbe.error.message !== 'Invalid rate limit parameters') {
      if (rateLimitProbe.error) {
        throwSupabaseError(
          'Could not verify the shared rate-limit function; apply the shared rate-limit migration and grant service_role access',
          rateLimitProbe.error,
          rateLimitProbe.status,
        );
      }
      throw new Error('The shared rate-limit function accepted invalid verification parameters');
    }
  }

  async ensureActor(actorId: string): Promise<void> {
    const result = await this.client.from('actor_profiles').upsert({ actor_id: actorId }, { onConflict: 'actor_id' });
    if (result.error) throwSupabaseError('Could not verify actor profile', result.error, result.status);
  }

  async getActorRole(actorId: string): Promise<string | null> {
    const result = await this.client.from('actor_profiles').select('role').eq('actor_id', actorId).maybeSingle();
    if (result.error) throwSupabaseError('Could not verify actor role', result.error, result.status);
    return typeof result.data?.role === 'string' ? result.data.role : null;
  }

  async consumeRateLimit(
    bucketHash: string,
    windowSeconds: number,
    maximum: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }> {
    const result = await this.client.rpc('consume_api_rate_limit', {
      p_bucket_hash: bucketHash,
      p_window_seconds: windowSeconds,
      p_maximum: maximum,
    });
    if (result.error) throwSupabaseError('Could not apply shared rate limit', result.error, result.status);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row.allowed !== 'boolean' || !Number.isInteger(row.retry_after_seconds) ||
      !Number.isInteger(row.remaining)) {
      throw new Error('Shared rate limit returned an invalid response');
    }
    return {
      allowed: row.allowed,
      retryAfterSeconds: row.retry_after_seconds,
      remaining: row.remaining,
    };
  }

  async appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent> {
    const result = await this.client.from('consent_events').insert(event).select('*').single();
    if (result.error) throwSupabaseError('Could not append consent event', result.error, result.status);
    return result.data as ConsentEvent;
  }

  async listConsentEvents(actorId?: string): Promise<ConsentEvent[]> {
    let query = this.client.from('consent_events').select('*').order('occurred_at', { ascending: true });
    if (actorId) query = query.eq('actor_id', actorId);
    const result = await query;
    if (result.error) throwSupabaseError('Could not replay consent events', result.error, result.status);
    return result.data as ConsentEvent[];
  }

  async appendAuditPayload(payloadText: string): Promise<AuditEvent> {
    const result = await this.client.rpc('append_audit_event', { p_payload_text: payloadText });
    if (result.error) throwSupabaseError('Could not append audit event', result.error, result.status);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) throw new Error('Audit append returned no record');
    return {
      sequence: Number(row.sequence),
      payload_text: row.payload_text,
      previous_hash: row.previous_hash,
      event_hash: row.event_hash,
    };
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    const result = await this.client.from('audit_events').select('*').order('sequence', { ascending: true });
    if (result.error) throwSupabaseError('Could not read audit history', result.error, result.status);
    return (result.data ?? []).map((row: any) => ({
      sequence: Number(row.sequence), payload_text: row.payload_text,
      previous_hash: row.previous_hash, event_hash: row.event_hash,
    }));
  }

  async getAuditHead(): Promise<AuditHead | null> {
    const result = await this.client.from('audit_chain_heads').select('*').eq('id', 1).maybeSingle();
    if (result.error) throwSupabaseError('Could not read audit chain head', result.error, result.status);
    return result.data ? { sequence: Number(result.data.sequence), last_hash: result.data.last_hash } : null;
  }

  async insertProtectedFile(file: ProtectedFileRecord): Promise<ProtectedFileRecord> {
    const result = await this.client.from('protected_files').insert(file).select('*').single();
    if (result.error) throwSupabaseError('Could not register protected file', result.error, result.status);
    return result.data as ProtectedFileRecord;
  }

  async getProtectedFile(id: string): Promise<ProtectedFileRecord | null> {
    const result = await this.client.from('protected_files').select('*').eq('id', id).maybeSingle();
    if (result.error) throwSupabaseError('Could not read protected file', result.error, result.status);
    return result.data as ProtectedFileRecord | null;
  }

  async listProtectedFiles(actorId?: string): Promise<ProtectedFileRecord[]> {
    let query = this.client.from('protected_files').select('*').order('created_at', { ascending: false });
    if (actorId) query = query.eq('actor_id', actorId);
    const result = await query;
    if (result.error) throwSupabaseError('Could not list protected files', result.error, result.status);
    return (result.data ?? []) as ProtectedFileRecord[];
  }

  async insertApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const result = await this.client.from('approval_requests').insert(request).select('*').single();
    if (result.error) throwSupabaseError('Could not create approval request', result.error, result.status);
    return result.data as ApprovalRequest;
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const result = await this.client.from('approval_requests').select('*').eq('id', id).maybeSingle();
    if (result.error) throwSupabaseError('Could not read approval request', result.error, result.status);
    return result.data as ApprovalRequest | null;
  }

  async listApprovals(actorId?: string): Promise<ApprovalRequest[]> {
    let query = this.client.from('approval_requests').select('*').order('created_at', { ascending: false });
    if (actorId) query = query.eq('actor_id', actorId);
    const result = await query;
    if (result.error) throwSupabaseError('Could not list approval requests', result.error, result.status);
    return (result.data ?? []) as ApprovalRequest[];
  }

  async updateApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const result = await this.client.from('approval_requests').update(request).eq('id', request.id).select('*').single();
    if (result.error) throwSupabaseError('Could not update approval request', result.error, result.status);
    return result.data as ApprovalRequest;
  }
}

interface SupabaseErrorResponse {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

class SupabaseStorageError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly details?: string;
  readonly hint?: string;

  constructor(operation: string, error: SupabaseErrorResponse, status: number) {
    super(`${operation}: ${error.message}`);
    this.name = 'SupabaseStorageError';
    this.code = error.code;
    this.status = status;
    this.details = error.details ?? undefined;
    this.hint = error.hint ?? undefined;
  }
}

function throwSupabaseError(operation: string, error: SupabaseErrorResponse, status: number): never {
  throw new SupabaseStorageError(operation, error, status);
}

function cloneFile(file: ProtectedFileRecord): ProtectedFileRecord {
  return { ...file, permissions: [...file.permissions] };
}

export function createConsentStore(env: NodeJS.ProcessEnv = process.env): ApplicationStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url && !serviceRoleKey) {
    return env.NODE_ENV === 'production'
      ? memoryOrFail(env, 'Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to enable Supabase storage')
      : new MemoryConsentStore();
  }
  if (!url || !serviceRoleKey) {
    return memoryOrFail(env, 'Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to enable Supabase storage');
  }

  let projectUrl: URL;
  try {
    projectUrl = new URL(url);
  } catch {
    return memoryOrFail(env, 'SUPABASE_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(projectUrl.protocol) || !projectUrl.hostname || projectUrl.username || projectUrl.password) {
    return memoryOrFail(env, 'SUPABASE_URL must be a valid HTTP(S) URL');
  }
  if (env.NODE_ENV === 'production' && projectUrl.protocol !== 'https:') {
    return memoryOrFail(env, 'Production SUPABASE_URL must use HTTPS');
  }

  const isSecretKey = /^sb_secret_[A-Za-z0-9_-]+$/.test(serviceRoleKey);
  const isLegacyServiceKey = isLegacyServiceRoleKey(serviceRoleKey);
  if (!isSecretKey && !isLegacyServiceKey) {
    return memoryOrFail(env, 'SUPABASE_SERVICE_ROLE_KEY must be a Supabase server-side secret or service_role JWT');
  }

  try {
    return new SupabaseConsentStore(createClient<any>(projectUrl.toString(), serviceRoleKey, { auth: { persistSession: false } }));
  } catch {
    return memoryOrFail(env, 'Could not initialize Supabase client; check the Supabase server-side configuration');
  }
}

function memoryOrFail(env: NodeJS.ProcessEnv, reason: string): ApplicationStore {
  if (env.NODE_ENV === 'production') throw new Error(`Production storage configuration failed: ${reason}`);
  return new MemoryConsentStore(reason);
}

function isLegacyServiceRoleKey(key: string): boolean {
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}