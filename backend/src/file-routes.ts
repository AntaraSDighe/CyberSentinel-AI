import { Router } from 'express';
import { ProtectedFileDeniedError, ProtectedFileService } from './protected-files.js';
import type { AuditService } from './audit.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';
import { actorIdFor } from './authentication.js';

const hashPattern = /^[a-f0-9]{64}$/;
const permissionValues = new Set(['read', 'export']);

export function createFileRouter(files: ProtectedFileService, audit: AuditService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/', async (request, response) => {
    const actorId = actorIdFor(request);
    try {
      response.json({ files: await files.list(actorId) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/', async (request, response) => {
    const { name, size, sha256, contentType = 'application/octet-stream', permissions = ['read', 'export'] } = request.body ?? {};
    const allowedFields = new Set(['name', 'size', 'sha256', 'contentType', 'permissions']);
    if (Object.keys(request.body ?? {}).some((field) => !allowedFields.has(field))) {
      return response.status(400).json({ error: 'Only file metadata and fingerprint are accepted; file contents are never uploaded' });
    }
    if (typeof name !== 'string' || name.length < 1 || name.length > 255 ||
      !Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !hashPattern.test(sha256) ||
      typeof contentType !== 'string' || contentType.length > 120 || !Array.isArray(permissions) ||
      permissions.some((permission: unknown) => typeof permission !== 'string' || !permissionValues.has(permission))) {
      return response.status(400).json({ error: 'Valid metadata and a SHA-256 fingerprint are required; file contents are not accepted' });
    }
    try {
      response.status(201).json({ file: await files.register({ actorId: actorIdFor(request), name, size, sha256, contentType, permissions }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/:fileId/history', async (request, response) => {
    const actorId = actorIdFor(request);
    if (!/^[0-9a-f-]{36}$/i.test(request.params.fileId)) return response.status(400).json({ error: 'Valid fileId is required' });
    const decision = projection.authorize(actorId, 'files:read');
    if (!decision.allowed) return response.status(403).json(decision);
    try {
      const file = await files.findOwned(actorId, request.params.fileId);
      response.json({ events: await audit.historyForResource(file.id) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/:fileId/access', async (request, response) => {
    const actorId = actorIdFor(request);
    if (!/^[0-9a-f-]{36}$/i.test(request.params.fileId)) return response.status(400).json({ error: 'Valid fileId is required' });
    try {
      response.json({ file: await files.access(actorId, request.params.fileId), contentAvailable: false });
    } catch (error) {
      sendError(response, error);
    }
  });
  return router;
}

function sendError(response: import('express').Response, error: unknown): void {
  const denied = error instanceof ProtectedFileDeniedError;
  if (denied) {
    if (error.decision) {
      response.status(403).json({
        error: 'Consent is required for this protected file operation',
        ...error.decision,
      });
      return;
    }
    response.status(403).json({ error: error.message });
    return;
  }
  sendApiError(response, error, 'protected_file.operation', 503, 'Protected file service unavailable');
}
