export type ConsentType = 'GRANTED' | 'REVOKED' | 'EXPIRED';

export interface ConsentEvent {
  id: string;
  actor_id: string;
  scope: string;
  event_type: ConsentType;
  occurred_at: string;
  expires_at: string | null;
}

export interface ConsentStatus {
  actorId: string;
  scope: string;
  status: 'granted' | 'revoked' | 'expired' | 'missing';
  event: ConsentEvent | null;
}

export interface AuditEvent {
  sequence: number;
  payload_text: string;
  previous_hash: string | null;
  event_hash: string;
}

export interface AuditHead {
  sequence: number;
  last_hash: string;
}

export interface AuditPayload {
  action: string;
  actorId: string | null;
  resource: string;
  operation: string;
  decision: 'allowed' | 'denied' | 'recorded' | 'error';
  occurredAt: string;
  details: Record<string, unknown>;
}

export interface ProtectedFileRecord {
  id: string;
  actor_id: string;
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  permissions: string[];
  created_at: string;
}

export type ApprovalState = 'pending' | 'approved' | 'expired' | 'failed' | 'released';

export interface ApprovalRequest {
  id: string;
  actor_id: string;
  file_id: string;
  status: ApprovalState;
  otp_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
  approved_at: string | null;
}