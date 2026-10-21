import { Router } from 'express';
import { ConsentConflictError, ConsentInputError, ConsentService } from './consent.js';
import type { AuditService } from './audit.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createConsentRouter(service: ConsentService, audit: AuditService): Router {
  const router = Router();

  router.get('/', async (request, response) => {
    try {
      const actorId = typeof request.query.actorId === 'string' ? request.query.actorId : undefined;
      if (actorId && !identifierPattern.test(actorId)) return response.status(400).json({ error: 'Invalid actorId' });
      response.json({ storage: service.storageMode, consents: await service.statuses(actorId) });
    } catch (error) {
      response.status(503).json({ error: messageOf(error) });
    }
  });

  router.get('/:actorId/:scope/events', async (request, response) => {
    const { actorId, scope } = request.params;
    if (!validIdentifier(actorId) || !validIdentifier(scope)) return response.status(400).json({ error: 'Invalid actorId or scope' });
    try {
      const events = await service.history(actorId);
      response.json({ actorId, scope, events: events.filter((event) => event.scope === scope) });
    } catch (error) {
      response.status(503).json({ error: messageOf(error) });
    }
  });

  router.get('/:actorId/:scope', async (request, response) => {
    const { actorId, scope } = request.params;
    if (!validIdentifier(actorId) || !validIdentifier(scope)) return response.status(400).json({ error: 'Invalid actorId or scope' });
    try {
      response.json(await service.status(actorId, scope));
    } catch (error) {
      response.status(503).json({ error: messageOf(error) });
    }
  });

  router.post('/', async (request, response) => {
    const { actorId, scope, expiresAt = null } = request.body ?? {};
    if (!validIdentifier(actorId) || !validIdentifier(scope) || (expiresAt !== null && typeof expiresAt !== 'string')) {
      return response.status(400).json({ error: 'actorId and scope are required; expiresAt must be an ISO-8601 string or null' });
    }
    try {
      const event = await service.grant(actorId, scope, expiresAt);
      await audit.record({ action: 'consent.granted', actorId, resource: scope, operation: 'grant-consent', decision: 'recorded', details: { consentEventId: event.id, expiresAt: event.expires_at } });
      response.status(201).json({ event, status: await service.status(actorId, scope) });
    } catch (error) {
      response.status(error instanceof ConsentInputError ? 400 : 503).json({ error: messageOf(error) });
    }
  });

  router.post('/:actorId/:scope/revoke', async (request, response) => {
    const { actorId, scope } = request.params;
    if (!validIdentifier(actorId) || !validIdentifier(scope)) return response.status(400).json({ error: 'Invalid actorId or scope' });
    try {
      const event = await service.revoke(actorId, scope);
      await audit.record({ action: 'consent.revoked', actorId, resource: scope, operation: 'revoke-consent', decision: 'recorded', details: { consentEventId: event.id } });
      response.status(201).json({ event });
    } catch (error) {
      response.status(error instanceof ConsentConflictError ? 409 : 503).json({ error: messageOf(error) });
    }
  });

  router.post('/:actorId/:scope/expire', async (request, response) => {
    const { actorId, scope } = request.params;
    if (!validIdentifier(actorId) || !validIdentifier(scope)) return response.status(400).json({ error: 'Invalid actorId or scope' });
    try {
      const event = await service.expire(actorId, scope);
      await audit.record({ action: 'consent.expired', actorId, resource: scope, operation: 'expire-consent', decision: 'recorded', details: { consentEventId: event.id } });
      response.status(201).json({ event });
    } catch (error) {
      response.status(error instanceof ConsentConflictError ? 409 : 503).json({ error: messageOf(error) });
    }
  });

  return router;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Consent storage unavailable';
}