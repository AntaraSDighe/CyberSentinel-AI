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
}

export class MemoryConsentStore implements ApplicationStore {
  readonly databaseConfigured = false;
  readonly mode = 'in-memory development storage (ephemeral; data is lost on restart)';
  private readonly events: ConsentEvent[] = [];
  private readonly auditEvents: AuditEvent[] = [];
  private readonly files = new Map<string, ProtectedFileRecord>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly actors = new Set<string>();

  async ensureActor(actorId: string): Promise<void> {
    this.actors.add(actorId);
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

  constructor(private readonly client: SupabaseClient<any>) {}

  async ensureActor(actorId: string): Promise<void> {
    const { error } = await this.client.from('actor_profiles').upsert({ actor_id: actorId }, { onConflict: 'actor_id' });
    if (error) throw new Error(`Could not verify actor profile: ${error.message}`);
  }

  async appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent> {
    const { data, error } = await this.client.from('consent_events').insert(event).select('*').single();
    if (error) throw new Error(`Could not append consent event: ${error.message}`);
    return data as ConsentEvent;
  }

  async listConsentEvents(actorId?: string): Promise<ConsentEvent[]> {
    let query = this.client.from('consent_events').select('*').order('occurred_at', { ascending: true });
    if (actorId) query = query.eq('actor_id', actorId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not replay consent events: ${error.message}`);
    return data as ConsentEvent[];
  }

  async appendAuditPayload(payloadText: string): Promise<AuditEvent> {
    const { data, error } = await this.client.rpc('append_audit_event', { p_payload_text: payloadText });
    if (error) throw new Error(`Could not append audit event: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Audit append returned no record');
    return {
      sequence: Number(row.sequence),
      payload_text: row.payload_text,
      previous_hash: row.previous_hash,
      event_hash: row.event_hash,
    };
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    const { data, error } = await this.client.from('audit_events').select('*').order('sequence', { ascending: true });
    if (error) throw new Error(`Could not read audit history: ${error.message}`);
    return (data ?? []).map((row: any) => ({
      sequence: Number(row.sequence), payload_text: row.payload_text,
      previous_hash: row.previous_hash, event_hash: row.event_hash,
    }));
  }

  async getAuditHead(): Promise<AuditHead | null> {
    const { data, error } = await this.client.from('audit_chain_heads').select('*').eq('id', 1).maybeSingle();
    if (error) throw new Error(`Could not read audit chain head: ${error.message}`);
    return data ? { sequence: Number(data.sequence), last_hash: data.last_hash } : null;
  }

  async insertProtectedFile(file: ProtectedFileRecord): Promise<ProtectedFileRecord> {
    const { data, error } = await this.client.from('protected_files').insert(file).select('*').single();
    if (error) throw new Error(`Could not register protected file: ${error.message}`);
    return data as ProtectedFileRecord;
  }

  async getProtectedFile(id: string): Promise<ProtectedFileRecord | null> {
    const { data, error } = await this.client.from('protected_files').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Could not read protected file: ${error.message}`);
    return data as ProtectedFileRecord | null;
  }

  async listProtectedFiles(actorId?: string): Promise<ProtectedFileRecord[]> {
    let query = this.client.from('protected_files').select('*').order('created_at', { ascending: false });
    if (actorId) query = query.eq('actor_id', actorId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not list protected files: ${error.message}`);
    return (data ?? []) as ProtectedFileRecord[];
  }

  async insertApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const { data, error } = await this.client.from('approval_requests').insert(request).select('*').single();
    if (error) throw new Error(`Could not create approval request: ${error.message}`);
    return data as ApprovalRequest;
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const { data, error } = await this.client.from('approval_requests').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Could not read approval request: ${error.message}`);
    return data as ApprovalRequest | null;
  }

  async listApprovals(actorId?: string): Promise<ApprovalRequest[]> {
    let query = this.client.from('approval_requests').select('*').order('created_at', { ascending: false });
    if (actorId) query = query.eq('actor_id', actorId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not list approval requests: ${error.message}`);
    return (data ?? []) as ApprovalRequest[];
  }

  async updateApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    const { data, error } = await this.client.from('approval_requests').update(request).eq('id', request.id).select('*').single();
    if (error) throw new Error(`Could not update approval request: ${error.message}`);
    return data as ApprovalRequest;
  }
}

function cloneFile(file: ProtectedFileRecord): ProtectedFileRecord {
  return { ...file, permissions: [...file.permissions] };
}

export function createConsentStore(env: NodeJS.ProcessEnv = process.env): ApplicationStore {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (Boolean(url) !== Boolean(serviceRoleKey)) {
    throw new Error('Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to enable Supabase storage');
  }
  if (!url || !serviceRoleKey) return new MemoryConsentStore();
  return new SupabaseConsentStore(createClient<any>(url, serviceRoleKey, { auth: { persistSession: false } }));
}