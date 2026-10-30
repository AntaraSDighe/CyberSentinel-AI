import express from 'express';
import { fileURLToPath } from 'node:url';
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
import { logApiError } from './errors.js';
import { createCorsMiddleware } from './cors.js';
import { createAuthenticationMiddleware } from './authentication.js';
import { createAuthRouter } from './auth-routes.js';
import { createIdentityProvider } from './identity.js';
import { createRateLimitMiddleware } from './rate-limits.js';
import { createFrontendHandler } from './frontend-serving.js';

export const app = express();
app.disable('x-powered-by');
app.use(createCorsMiddleware());
app.use(express.json({ limit: '16kb' }));

export const platformStore = createConsentStore();
export const identityProvider = createIdentityProvider(process.env, platformStore);
const rateLimitSecret = process.env.NODE_ENV === 'production'
  ? process.env.OTP_SECRET ?? ''
  : 'development-only-rate-limit-secret';
export const consentService = new ConsentService(platformStore);
export const auditService = new AuditService(platformStore);
export const consentProjection = new ConsentProjection(consentService);
export const geminiAnalyzer = new GeminiRiskAnalyzer(process.env.GEMINI_API_KEY, auditService);
export const protectedFileService = new ProtectedFileService(platformStore, consentProjection, auditService);
export const approvalService = new ApprovalService(platformStore, createApprovalDelivery(), auditService, consentProjection);

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.get('/api/health/live', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'cybersentinel-api',
    timestamp: new Date().toISOString(),
  });
});
app.get('/api/config/status', (_request, response) => {
  const approval = approvalService.status;
  response.json({
    ai: {
      available: geminiAnalyzer.available,
      missingVariableNames: geminiAnalyzer.available ? [] : ['GEMINI_API_KEY'],
    },
    approvals: {
      available: approval.available,
      otpConfigured: approval.otpConfigured,
      deliveryChannel: approval.deliveryChannel,
      missingVariableNames: approval.missingVariableNames,
      deliveryRequirementAlternatives: approval.deliveryRequirementAlternatives,
      configurationError: approval.configurationError,
    },
  });
});

app.get('/api/health', (_request, response) => {
  const gateway = consentProjection.health();
  const audit = auditService.health();
  const databaseAvailable = platformStore.databaseConfigured && gateway.ready && gateway.consistent &&
    gateway.error === null && gateway.ageMs !== null && gateway.ageMs <= gateway.maxAgeMs &&
    audit.ready && audit.consistent;
  response.status(process.env.NODE_ENV === 'production' && !databaseAvailable ? 503 : 200).json({
    status: databaseAvailable || process.env.NODE_ENV !== 'production' ? 'ok' : 'unavailable',
    service: 'cybersentinel-api',
    timestamp: new Date().toISOString(),
    storage: consentService.storageMode,
    database: {
      configured: platformStore.databaseConfigured,
      available: databaseAvailable,
      error: !platformStore.databaseConfigured
        ? platformStore.configurationError
        : databaseAvailable
          ? null
          : 'Supabase storage could not be verified; check credentials and apply migrations',
    },
    ai: {
      available: geminiAnalyzer.available,
      provider: 'Google Gemini',
      model: geminiAnalyzer.available ? geminiAnalyzer.model : null,
      missingVariableNames: geminiAnalyzer.available ? [] : ['GEMINI_API_KEY'],
      configurationError: geminiAnalyzer.configurationError,
    },
    gateway,
    audit,
  });
});

app.use('/api', createRateLimitMiddleware(
  platformStore,
  rateLimitSecret,
  'ip',
));
app.use('/api', createAuthenticationMiddleware(identityProvider));
app.use('/api', createRateLimitMiddleware(
  platformStore,
  rateLimitSecret,
  'identity',
));
app.use('/api/auth', createAuthRouter(identityProvider));
app.use('/api/consents', createConsentRouter(consentService, auditService));
app.use('/api/gateway', createGatewayRouter(consentProjection, auditService));
app.use('/api/audit', createAuditRouter(auditService, consentProjection));
app.use('/api/ai', createAiRouter(geminiAnalyzer));
app.use('/api/files', createFileRouter(protectedFileService, auditService, consentProjection));
app.use('/api/approvals', createApprovalRouter(approvalService, protectedFileService, consentProjection));

if (process.env.NODE_ENV === 'production' && process.env.VERCEL !== '1') {
  const frontendDistPath = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  app.use(createFrontendHandler(frontendDistPath));
}

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.use((error: unknown, request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) return next(error);
  const isInvalidBody = error instanceof SyntaxError && 'body' in error;
  logApiError(`${request.method} ${request.path}`, error);
  response.status(isInvalidBody ? 400 : 500).json({
    error: isInvalidBody ? 'Invalid JSON request body' : 'Internal server error',
  });
});