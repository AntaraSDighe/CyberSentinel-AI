import { Router } from 'express';
import type { ConsentProjection } from './gateway.js';
import type { AuditService } from './audit.js';
import { logApiError } from './errors.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createGatewayRouter(projection: ConsentProjection, audit: AuditService): Router {
  const router = Router();
  router.get('/health', (_request, response) => response.json(projection.health()));
  router.post('/evaluate', async (request, response) => {
    const { actorId, scope } = request.body ?? {};
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId) || typeof scope !== 'string' || !identifierPattern.test(scope)) {
      return response.status(400).json({ error: 'actorId and scope are required identifiers' });
    }
    const decision = projection.authorize(actorId, scope);
    try {
      await audit.record({
        action: 'gateway.authorization', actorId, resource: scope, operation: 'authorize',
        decision: decision.allowed ? 'allowed' : 'denied', details: { reason: decision.reason, consentStatus: decision.consentStatus },
      });
    } catch (error) {
      logApiError('gateway.evaluate.audit', error);
      return response.status(503).json({
        ...decision, allowed: false, reason: 'projection_unavailable',
        auditError: 'Audit storage unavailable',
      });
    }
    response.status(decision.allowed ? 200 : 403).json(decision);
  });
  return router;
}