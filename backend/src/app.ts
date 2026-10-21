import express from 'express';
import { ConsentService } from './consent.js';
import { createConsentRouter } from './consent-routes.js';
import { createConsentStore } from './storage.js';
import { ConsentProjection } from './gateway.js';
import { createGatewayRouter } from './gateway-routes.js';
import { AuditService } from './audit.js';
import { createAuditRouter } from './audit-routes.js';
import { GeminiRiskAnalyzer } from './ai.js';
import { createAiRouter } from './ai-routes.js';
import { ProtectedFileService } from './protected-files.js';
import { createFileRouter } from './file-routes.js';
import { ApprovalService } from './approvals.js';
import { createApprovalDelivery } from './approval-delivery.js';
import { createApprovalRouter } from './approval-routes.js';

export const app = express();
const platformStore = createConsentStore();
const consentService = new ConsentService(platformStore);
export const auditService = new AuditService(platformStore);
export const consentProjection = new ConsentProjection(consentService);
export const geminiAnalyzer = new GeminiRiskAnalyzer(process.env.GEMINI_API_KEY, {
  consent: consentService, projection: consentProjection, audit: auditService,
});
export const protectedFileService = new ProtectedFileService(platformStore, consentProjection, auditService);
export const approvalService = new ApprovalService(platformStore, createApprovalDelivery(), auditService, consentProjection);

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: 'cybersentinel-api',
    timestamp: new Date().toISOString(),
    storage: consentService.storageMode,
    gateway: consentProjection.health(),
    audit: auditService.health(),
  });
});

app.use('/api/consents', createConsentRouter(consentService, auditService));
app.use('/api/gateway', createGatewayRouter(consentProjection, auditService));
app.use('/api/audit', createAuditRouter(auditService, consentProjection));
app.use('/api/ai', createAiRouter(geminiAnalyzer));
app.use('/api/files', createFileRouter(protectedFileService, auditService, consentProjection));
app.use('/api/approvals', createApprovalRouter(approvalService, protectedFileService, consentProjection));

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});