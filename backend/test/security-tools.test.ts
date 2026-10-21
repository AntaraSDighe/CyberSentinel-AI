import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditService } from '../src/audit.js';
import { ConsentService } from '../src/consent.js';
import { executeSecurityTool } from '../src/security-tools.js';
import { ConsentProjection } from '../src/gateway.js';
import { MemoryConsentStore } from '../src/storage.js';

async function createContext() {
  const store = new MemoryConsentStore();
  const consent = new ConsentService(store);
  const audit = new AuditService(store);
  const projection = new ConsentProjection(consent);
  await Promise.all([audit.initialize(), projection.initialize()]);
  return { store, consent, audit, projection };
}

describe('AI and MCP security tools', () => {
  it('reports a missing consent without granting access', async () => {
    const context = await createContext();
    const status = await executeSecurityTool(context, 'check_consent', { actorId: 'actor-1', scope: 'files:read' }) as { status: string };
    const decision = await executeSecurityTool(context, 'evaluate_access', { actorId: 'actor-1', scope: 'files:read' }) as { allowed: boolean };
    assert.equal(status.status, 'missing');
    assert.equal(decision.allowed, false);
  });

  it('requires gateway consent before exposing audit history or verification', async () => {
    const context = await createContext();
    await assert.rejects(executeSecurityTool(context, 'review_audit_history', { actorId: 'actor-1' }), /Denied by security gateway/);
    await assert.rejects(executeSecurityTool(context, 'verify_audit_chain', { actorId: 'actor-1' }), /Denied by security gateway/);
    await context.consent.grant('actor-1', 'audit:read');
    const history = await executeSecurityTool(context, 'review_audit_history', { actorId: 'actor-1' });
    assert.deepEqual(history, []);
  });

  it('validates tool names and arguments instead of accepting model-provided arbitrary input', async () => {
    const context = await createContext();
    await assert.rejects(executeSecurityTool(context, 'evaluate_access', { actorId: 'actor-1', scope: '../../' }));
    await assert.rejects(executeSecurityTool(context, 'unknown_tool', {}), /Unknown security tool/);
  });
});