import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApprovalRequest, ProtectedFileRecord } from './domain.js';
import type { AuditService } from './audit.js';
import type { ConsentProjection } from './gateway.js';
import type { ApprovalDelivery } from './approval-delivery.js';
import type { ProtectedDataStore } from './storage.js';

export class ApprovalService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly secret: string;

  constructor(
    private readonly store: ProtectedDataStore,
    private readonly delivery: ApprovalDelivery,
    private readonly audit: AuditService,
    private readonly projection: ConsentProjection,
    secret = process.env.OTP_SECRET ?? '',
    private readonly clock: () => number = Date.now,
  ) {
    this.secret = secret;
  }

  get status(): { available: boolean; deliveryChannel: string | null; otpConfigured: boolean; deadlineSeconds: number } {
    return { available: this.delivery.available && this.secret.length >= 32, deliveryChannel: this.delivery.channel, otpConfigured: this.secret.length >= 32, deadlineSeconds: 60 };
  }

  async list(actorId?: string): Promise<Array<Omit<ApprovalRequest, 'otp_hash'>>> {
    const requests = await this.store.listApprovals(actorId);
    const now = this.clock();
    const result = [];
    for (const request of requests) {
      const current = await this.expireIfOverdue(request, now);
      const { otp_hash: _otpHash, ...safeRequest } = current;
      result.push(safeRequest);
    }
    return result;
  }

  async requestExport(actorId: string, file: ProtectedFileRecord): Promise<Omit<ApprovalRequest, 'otp_hash'>> {
    if (!this.status.available) throw new ApprovalUnavailableError('OTP secret and a working email or Telegram delivery provider are required');
    if (!file.permissions.includes('export')) throw new ApprovalDeniedError('File metadata does not permit export');
    const decision = this.projection.authorize(actorId, 'payments:export');
    await this.audit.record({
      action: 'approval.request', actorId, resource: file.id, operation: 'metadata-export',
      decision: decision.allowed ? 'recorded' : 'denied', details: { reason: decision.reason },
    });
    if (!decision.allowed) throw new ApprovalDeniedError(`Denied by security gateway: ${decision.reason}`);

    const now = this.clock();
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const request: ApprovalRequest = {
      id, actor_id: actorId, file_id: file.id, status: 'pending', otp_hash: this.hash(id, code),
      expires_at: new Date(now + 60_000).toISOString(), attempts: 0,
      created_at: new Date(now).toISOString(), approved_at: null,
    };
    const saved = await this.store.insertApproval(request);
    try {
      await this.delivery.send(code, id);
      await this.audit.record({
        action: 'approval.otp-delivered', actorId, resource: id, operation: 'deliver-otp',
        decision: 'recorded', details: { channel: this.delivery.channel, deadlineSeconds: 60 },
      });
    } catch (error) {
      await this.store.updateApproval({ ...saved, status: 'failed' });
      await this.audit.record({ action: 'approval.delivery-failed', actorId, resource: id, operation: 'deliver-otp', decision: 'error', details: {} }).catch(() => undefined);
      throw new ApprovalUnavailableError(error instanceof Error ? error.message : 'OTP delivery failed');
    }
    const { otp_hash: _otpHash, ...safeRequest } = saved;
    return safeRequest;
  }

  async approve(id: string, code: string): Promise<Omit<ApprovalRequest, 'otp_hash'>> {
    if (!/^\d{6}$/.test(code)) throw new ApprovalDeniedError('OTP must be a six-digit code');
    return this.withLock(id, async () => {
      let request = await this.store.getApproval(id);
      if (!request) throw new ApprovalNotFoundError('Approval request not found');
      request = await this.expireIfOverdue(request, this.clock());
      if (request.status !== 'pending') throw new ApprovalDeniedError(`Approval request is ${request.status}`);
      if (request.attempts >= 5) {
        await this.store.updateApproval({ ...request, status: 'failed' });
        throw new ApprovalDeniedError('Approval request locked after too many invalid attempts');
      }
      const actual = Buffer.from(this.hash(id, code), 'hex');
      const expected = Buffer.from(request.otp_hash, 'hex');
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!valid) {
        const attempts = request.attempts + 1;
        await this.store.updateApproval({ ...request, attempts, status: attempts >= 5 ? 'failed' : 'pending' });
        throw new ApprovalDeniedError('Invalid approval code');
      }
      const approved: ApprovalRequest = { ...request, status: 'approved', approved_at: new Date(this.clock()).toISOString() };
      await this.store.updateApproval(approved);
      try {
        await this.audit.record({ action: 'approval.approved', actorId: request.actor_id, resource: id, operation: 'approve', decision: 'recorded', details: {} });
      } catch (error) {
        await this.store.updateApproval({ ...approved, status: 'failed' });
        throw error;
      }
      return safeRequest(approved);
    });
  }

  async release(id: string, actorId: string, getFile: (fileId: string) => Promise<ProtectedFileRecord>): Promise<ProtectedFileRecord> {
    return this.withLock(id, async () => {
      let request = await this.store.getApproval(id);
      if (!request || request.actor_id !== actorId) throw new ApprovalNotFoundError('Approval request not found');
      request = await this.expireIfOverdue(request, this.clock());
      if (request.status !== 'approved' || !request.approved_at || this.clock() > Date.parse(request.expires_at)) {
        throw new ApprovalDeniedError('A valid, unexpired administrator approval is required');
      }
      const decision = this.projection.authorize(actorId, 'payments:export');
      await this.audit.record({
        action: 'approval.export-release', actorId, resource: request.file_id, operation: 'metadata-export',
        decision: decision.allowed ? 'allowed' : 'denied', details: { approvalId: request.id, reason: decision.reason },
      });
      if (!decision.allowed) throw new ApprovalDeniedError(`Consent recheck denied export: ${decision.reason}`);
      const file = await getFile(request.file_id);
      if (!file.permissions.includes('export')) throw new ApprovalDeniedError('File metadata does not permit export');
      await this.store.updateApproval({ ...request, status: 'released' });
      return file;
    });
  }

  private async expireIfOverdue(request: ApprovalRequest, now: number): Promise<ApprovalRequest> {
    if ((request.status === 'pending' || request.status === 'approved') && now > Date.parse(request.expires_at)) {
      const expired = { ...request, status: 'expired' as const };
      await this.store.updateApproval(expired);
      await this.audit.record({ action: 'approval.expired', actorId: request.actor_id, resource: request.id, operation: 'expire', decision: 'denied', details: {} }).catch(() => undefined);
      return expired;
    }
    return request;
  }

  private hash(id: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${id}:${code}`).digest('hex');
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
}

function safeRequest(request: ApprovalRequest): Omit<ApprovalRequest, 'otp_hash'> {
  const { otp_hash: _otpHash, ...safe } = request;
  return safe;
}

export class ApprovalDeniedError extends Error {}
export class ApprovalUnavailableError extends Error {}
export class ApprovalNotFoundError extends Error {}