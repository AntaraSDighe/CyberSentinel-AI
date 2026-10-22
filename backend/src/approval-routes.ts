import { Router } from 'express';
import {
  ApprovalDeniedError, ApprovalNotFoundError, ApprovalService, ApprovalUnavailableError,
} from './approvals.js';
import { ProtectedFileDeniedError, ProtectedFileService } from './protected-files.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';

const identifierPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createApprovalRouter(approvals: ApprovalService, files: ProtectedFileService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/status', (_request, response) => response.json(approvals.status));
  router.get('/', async (request, response) => {
    const actorId = request.query.actorId;
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId)) return response.status(400).json({ error: 'actorId is required' });
    const decision = projection.authorize(actorId, 'approvals:read');
    if (!decision.allowed) return response.status(403).json(decision);
    try { response.json({ requests: await approvals.list(actorId) }); }
    catch (error) { sendApiError(response, error, 'approvals.list', 503, 'Approval storage unavailable'); }
  });

  router.post('/payment-export', async (request, response) => {
    const { actorId, fileId } = request.body ?? {};
    if (typeof actorId !== 'string' || !identifierPattern.test(actorId) || typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      return response.status(400).json({ error: 'actorId and valid fileId are required' });
    }
    try {
      const file = await files.findOwned(actorId, fileId);
      response.status(201).json({ request: await approvals.requestExport(actorId, file), delivery: approvals.status.deliveryChannel });
    } catch (error) { sendError(response, error); }
  });

  router.post('/:id/approve', async (request, response) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id) || typeof request.body?.otp !== 'string') return response.status(400).json({ error: 'Approval id and OTP are required' });
    try { response.json({ request: await approvals.approve(request.params.id, request.body.otp) }); }
    catch (error) { sendError(response, error); }
  });

  router.post('/:id/release', async (request, response) => {
    const actorId = request.body?.actorId;
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id) || typeof actorId !== 'string' || !identifierPattern.test(actorId)) return response.status(400).json({ error: 'Approval id and actorId are required' });
    try {
      const metadata = await approvals.release(request.params.id, actorId, (fileId) => files.findOwned(actorId, fileId));
      response.json({ exported: true, contentType: 'metadata-only', metadata });
    } catch (error) { sendError(response, error); }
  });
  return router;
}

function sendError(response: import('express').Response, error: unknown): void {
  const status = error instanceof ApprovalNotFoundError ? 404
    : error instanceof ApprovalUnavailableError ? 503
      : error instanceof ProtectedFileDeniedError || error instanceof ApprovalDeniedError ? 403 : 503;
  const publicMessage = error instanceof ApprovalNotFoundError ? 'Approval request not found'
    : error instanceof ApprovalUnavailableError ? 'Approval delivery is unavailable'
      : error instanceof ProtectedFileDeniedError || error instanceof ApprovalDeniedError ? error.message
        : 'Approval service unavailable';
  sendApiError(response, error, 'approvals.operation', status, publicMessage);
}