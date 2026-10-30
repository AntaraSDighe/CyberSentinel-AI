import { Router } from 'express';
import type { ConsentProjection } from './gateway.js';
import type { AuditService } from './audit.js';
import { logApiError } from './errors.js';
import { actorIdFor } from './authentication.js';

export function createGatewayRouter(projection: ConsentProjection, audit: AuditService): Router {
  const router = Router();
  router.get('/health', (_request, response) => response.json(projection.health()));
  router.post('/evaluate', async (request, response) => {
    const { scope } = request.body ?? {};
    const actorId = actorIdFor(request);
    if (typeof scope !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(scope)) {
      return response.status(400).json({ error: 'scope is required as an identifier' });
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