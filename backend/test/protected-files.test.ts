import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditService } from '../src/audit.js';
import { ConsentService } from '../src/consent.js';
import { ProtectedFileDeniedError, ProtectedFileService } from '../src/protected-files.js';
import { ConsentProjection } from '../src/gateway.js';
import { MemoryConsentStore } from '../src/storage.js';

describe('protected file metadata', () => {
  it('requires consent before registering or reading file metadata', async () => {
    const store = new MemoryConsentStore();
    const consent = new ConsentService(store);
    const audit = new AuditService(store);
    const projection = new ConsentProjection(consent);
    await Promise.all([audit.initialize(), projection.initialize()]);
    const files = new ProtectedFileService(store, projection, audit);

    await assert.rejects(files.register({
      actorId: 'actor-1', name: 'sample.txt', size: 8, sha256: 'b'.repeat(64), contentType: 'text/plain', permissions: ['read'],
    }), ProtectedFileDeniedError);

    await consent.grant('actor-1', 'files:register');
    await consent.grant('actor-1', 'files:read');
    const record = await files.register({
      actorId: 'actor-1', name: 'sample.txt', size: 8, sha256: 'b'.repeat(64), contentType: 'text/plain', permissions: ['read'],
    });
    assert.equal(record.sha256, 'b'.repeat(64));
    assert.equal((await files.list('actor-1')).length, 1);
    assert.equal((await files.access('actor-1', record.id)).name, 'sample.txt');
    await consent.revoke('actor-1', 'files:read');
    await assert.rejects(files.list('actor-1'), /Denied by security gateway/);
  });
});