import { Type, type FunctionDeclaration } from '@google/genai';
import { z } from 'zod';
import type { AuditService } from './audit.js';
import type { ConsentService } from './consent.js';
import type { ConsentProjection } from './gateway.js';

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const actorScope = z.object({ actorId: identifier, scope: identifier }).strict();
const actorOnly = z.object({ actorId: identifier }).strict();

export interface SecurityToolContext {
  consent: ConsentService;
  projection: ConsentProjection;
  audit: AuditService;
}

export const geminiSecurityDeclarations: FunctionDeclaration[] = [
  {
    name: 'check_consent',
    description: 'Read current consent status by replaying stored consent events. This is not an authorization grant.',
    parameters: { type: Type.OBJECT, properties: { actorId: { type: Type.STRING }, scope: { type: Type.STRING } }, required: ['actorId', 'scope'] },
  },
  {
    name: 'evaluate_access',
    description: 'Evaluate access using the fail-closed in-memory authorization projection. This tool cannot grant access.',
    parameters: { type: Type.OBJECT, properties: { actorId: { type: Type.STRING }, scope: { type: Type.STRING } }, required: ['actorId', 'scope'] },
  },
  {
    name: 'review_audit_history',
    description: 'Review recent audit history. Requires active audit:read consent for the supplied actor.',
    parameters: { type: Type.OBJECT, properties: { actorId: { type: Type.STRING } }, required: ['actorId'] },
  },
  {
    name: 'verify_audit_chain',
    description: 'Verify the SHA-256 audit chain and its database head anchor.',
    parameters: { type: Type.OBJECT, properties: { actorId: { type: Type.STRING } }, required: ['actorId'] },
  },
];

export async function executeSecurityTool(context: SecurityToolContext, name: string, rawArguments: unknown): Promise<unknown> {
  if (name === 'check_consent') {
    const { actorId, scope } = actorScope.parse(rawArguments);
    return context.consent.status(actorId, scope);
  }
  if (name === 'evaluate_access') {
    const { actorId, scope } = actorScope.parse(rawArguments);
    const decision = context.projection.authorize(actorId, scope);
    await context.audit.record({
      action: 'gateway.authorization', actorId, resource: scope, operation: 'ai-tool-evaluate',
      decision: decision.allowed ? 'allowed' : 'denied', details: { reason: decision.reason, source: 'ai-tool' },
    });
    return decision;
  }
  if (name === 'review_audit_history') {
    const { actorId } = actorOnly.parse(rawArguments);
    requireConsent(context, actorId, 'audit:read');
    return context.audit.list(50);
  }
  if (name === 'verify_audit_chain') {
    const { actorId } = actorOnly.parse(rawArguments);
    requireConsent(context, actorId, 'audit:read');
    return context.audit.verify();
  }
  throw new Error(`Unknown security tool: ${name}`);
}

function requireConsent(context: SecurityToolContext, actorId: string, scope: string): void {
  const decision = context.projection.authorize(actorId, scope);
  if (!decision.allowed) throw new Error(`Denied by security gateway: ${decision.reason}`);
}