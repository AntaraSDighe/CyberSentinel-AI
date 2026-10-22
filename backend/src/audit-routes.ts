import { Router } from 'express';
import type { AuditService } from './audit.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createAuditRouter(audit: AuditService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/', async (request, response) => {
    const limit = Number(request.query.limit ?? 100);
    const actorId = request.query.actorId;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || typeof actorId !== 'string' || !identifierPattern.test(actorId)) return response.status(400).json({ error: 'Valid actorId is required and limit must be from 1 to 500' });
    const decision = projection.authorize(actorId, 'audit:read');
    if (!decision.allowed) return response.status(403).json(decision);
    try {
      await audit.record({ action: 'audit.history-read', actorId, resource: 'audit-chain', operation: 'read', decision: 'allowed', details: {} });
      const [events, verification] = await Promise.all([audit.list(limit), audit.verify()]);
      response.json({ storage: audit.storageMode, verification, events });
    } catch (error) {
      sendApiError(response, error, 'audit.list', 503, 'Audit storage unavailable');
    }
  });
  router.post('/verify', async (request, response) => {
    const actorId = request.body?.actorId;
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId)) return response.status(400).json({ error: 'Valid actorId is required' });
    const decision = projection.authorize(actorId, 'audit:read');
    if (!decision.allowed) return response.status(403).json(decision);
    const result = await audit.verify();
    response.status(result.valid ? 200 : 409).json(result);
  });
  return router;
}