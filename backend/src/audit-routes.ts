import { Router } from 'express';
import type { AuditService } from './audit.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';
import { actorIdFor } from './authentication.js';

export function createAuditRouter(audit: AuditService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/', async (request, response) => {
    const limit = Number(request.query.limit ?? 100);
    const actorId = actorIdFor(request);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return response.status(400).json({ error: 'limit must be from 1 to 500' });
    const decision = projection.authorize(actorId, 'audit:read');
    if (!decision.allowed) return response.status(403).json(decision);
    try {
      await audit.record({ action: 'audit.history-read', actorId, resource: 'audit-chain', operation: 'read', decision: 'allowed', details: {} });
      const [events, verification] = await Promise.all([
        audit.list(limit, request.identity?.role === 'admin' ? undefined : actorId),
        audit.verify(),
      ]);
      response.json({ storage: audit.storageMode, verification, events });
    } catch (error) {
      sendApiError(response, error, 'audit.list', 503, 'Audit storage unavailable');
    }
  });
  router.post('/verify', async (request, response) => {
    const actorId = actorIdFor(request);
    const decision = projection.authorize(actorId, 'audit:read');
    if (!decision.allowed) return response.status(403).json(decision);
    const result = await audit.verify();
    response.status(!result.storageAvailable ? 503 : result.valid ? 200 : 409).json(result);
  });
  return router;
}