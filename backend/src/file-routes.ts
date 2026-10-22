import { Router } from 'express';
import { ProtectedFileDeniedError, ProtectedFileService } from './protected-files.js';
import type { AuditService } from './audit.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const permissionValues = new Set(['read', 'export']);

export function createFileRouter(files: ProtectedFileService, audit: AuditService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/', async (request, response) => {
    const actorId = request.query.actorId;
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId)) return response.status(400).json({ error: 'actorId is required' });
    try {
      response.json({ files: await files.list(actorId) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/', async (request, response) => {
    const { actorId, name, size, sha256, contentType = 'application/octet-stream', permissions = ['read', 'export'] } = request.body ?? {};
    const allowedFields = new Set(['actorId', 'name', 'size', 'sha256', 'contentType', 'permissions']);
    if (Object.keys(request.body ?? {}).some((field) => !allowedFields.has(field))) {
      return response.status(400).json({ error: 'Only file metadata and fingerprint are accepted; file contents are never uploaded' });
    }
    if (!isIdentifier(actorId) || typeof name !== 'string' || name.length < 1 || name.length > 255 ||
      !Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !hashPattern.test(sha256) ||
      typeof contentType !== 'string' || contentType.length > 120 || !Array.isArray(permissions) ||
      permissions.some((permission: unknown) => typeof permission !== 'string' || !permissionValues.has(permission))) {
      return response.status(400).json({ error: 'Valid metadata and a SHA-256 fingerprint are required; file contents are not accepted' });
    }
    try {
      response.status(201).json({ file: await files.register({ actorId, name, size, sha256, contentType, permissions }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/:fileId/history', async (request, response) => {
    const actorId = request.query.actorId;
    if (!isIdentifier(actorId) || !/^[0-9a-f-]{36}$/i.test(request.params.fileId)) return response.status(400).json({ error: 'actorId and valid fileId are required' });
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
    const actorId = request.body?.actorId;
    if (!isIdentifier(actorId) || !/^[0-9a-f-]{36}$/i.test(request.params.fileId)) return response.status(400).json({ error: 'actorId and valid fileId are required' });
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
  sendApiError(response, error, 'protected_file.operation', denied ? 403 : 503,
    denied ? error.message : 'Protected file service unavailable');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}