import { randomUUID } from 'node:crypto';
import type { AuditService } from './audit.js';
import type { ProtectedFileRecord } from './domain.js';
import type { ConsentProjection } from './gateway.js';
import type { ProtectedDataStore } from './storage.js';

export class ProtectedFileService {
  constructor(
    private readonly store: ProtectedDataStore,
    private readonly projection: ConsentProjection,
    private readonly audit: AuditService,
  ) {}

  async register(input: { actorId: string; name: string; size: number; sha256: string; contentType: string; permissions: string[] }): Promise<ProtectedFileRecord> {
    await this.requireAccess(input.actorId, 'files:register', 'files.register', input.name);
    const record: ProtectedFileRecord = {
      id: randomUUID(), actor_id: input.actorId, name: input.name, size: input.size,
      sha256: input.sha256, content_type: input.contentType,
      permissions: [...new Set(input.permissions)], created_at: new Date().toISOString(),
    };
    const saved = await this.store.insertProtectedFile(record);
    await this.audit.record({
      action: 'files.register', actorId: input.actorId, resource: saved.id,
      operation: 'metadata-register', decision: 'recorded',
      details: { name: saved.name, size: saved.size, sha256: saved.sha256, contentType: saved.content_type },
    });
    return saved;
  }

  async list(actorId: string): Promise<ProtectedFileRecord[]> {
    await this.requireAccess(actorId, 'files:read', 'files.list', 'protected-files');
    return this.store.listProtectedFiles(actorId);
  }

  async access(actorId: string, fileId: string): Promise<ProtectedFileRecord> {
    const file = await this.store.getProtectedFile(fileId);
    if (!file || file.actor_id !== actorId) throw new ProtectedFileDeniedError('File not found or not owned by this actor');
    if (!file.permissions.includes('read')) throw new ProtectedFileDeniedError('File metadata does not permit read access');
    await this.requireAccess(actorId, 'files:read', 'files.access', file.id);
    await this.audit.record({
      action: 'files.access', actorId, resource: file.id, operation: 'metadata-read',
      decision: 'allowed', details: { sha256: file.sha256 },
    });
    return file;
  }

  async findOwned(actorId: string, fileId: string): Promise<ProtectedFileRecord> {
    const file = await this.store.getProtectedFile(fileId);
    if (!file || file.actor_id !== actorId) throw new ProtectedFileDeniedError('File not found or not owned by this actor');
    return file;
  }

  private async requireAccess(actorId: string, scope: string, action: string, resource: string): Promise<void> {
    const decision = this.projection.authorize(actorId, scope);
    await this.audit.record({
      action, actorId, resource, operation: action, decision: decision.allowed ? 'allowed' : 'denied',
      details: { reason: decision.reason },
    });
    if (!decision.allowed) throw new ProtectedFileDeniedError(`Denied by security gateway: ${decision.reason}`);
  }
}

export class ProtectedFileDeniedError extends Error {}