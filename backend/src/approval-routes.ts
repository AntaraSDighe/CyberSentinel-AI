import { Router } from 'express';
import {
  ApprovalDeniedError, ApprovalNotFoundError, ApprovalService, ApprovalUnavailableError,
} from './approvals.js';
import { ProtectedFileDeniedError, ProtectedFileService } from './protected-files.js';
import type { ConsentProjection } from './gateway.js';
import { sendApiError } from './errors.js';
import { actorIdFor, requireAdministrator } from './authentication.js';

export function createApprovalRouter(approvals: ApprovalService, files: ProtectedFileService, projection: ConsentProjection): Router {
  const router = Router();
  router.get('/status', (_request, response) => response.json(approvals.status));
  router.get('/', async (request, response) => {
    const actorId = actorIdFor(request);
    const decision = projection.authorize(actorId, 'approvals:read');
    if (!decision.allowed) return response.status(403).json(decision);
    try { response.json({ requests: await approvals.list(request.identity?.role === 'admin' ? undefined : actorId) }); }
    catch (error) { sendApiError(response, error, 'approvals.list', 503, 'Approval storage unavailable'); }
  });

  router.post('/payment-export', async (request, response) => {
    const { fileId } = request.body ?? {};
    const actorId = actorIdFor(request);
    if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      return response.status(400).json({ error: 'Valid fileId is required' });
    }
    try {
      const file = await files.findOwned(actorId, fileId);
      response.status(201).json({ request: await approvals.requestExport(actorId, file), delivery: approvals.status.deliveryChannel });
    } catch (error) { sendError(response, error); }
  });

  router.post('/:id/approve', requireAdministrator, async (request, response) => {
    const approvalId = request.params.id;
    if (typeof approvalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(approvalId) || typeof request.body?.otp !== 'string') return response.status(400).json({ error: 'Approval id and OTP are required' });
    try { response.json({ request: await approvals.approve(approvalId, request.body.otp) }); }
    catch (error) { sendError(response, error); }
  });

  router.post('/:id/release', async (request, response) => {
    const actorId = actorIdFor(request);
    const approvalId = request.params.id;
    if (typeof approvalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(approvalId)) return response.status(400).json({ error: 'Approval id is required' });
    try {
      const metadata = await approvals.release(approvalId, actorId, (fileId) => files.findOwned(actorId, fileId));
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
    : error instanceof ApprovalUnavailableError ? error.message
      : error instanceof ProtectedFileDeniedError || error instanceof ApprovalDeniedError ? error.message
        : 'Approval service unavailable';
  sendApiError(response, error, 'approvals.operation', status, publicMessage);
}