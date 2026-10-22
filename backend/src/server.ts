import './env.js';
import { app, auditService, consentProjection } from './app.js';
import { logApiError } from './errors.js';

const port = Number(process.env.PORT ?? 3001);

async function start(): Promise<void> {
  await Promise.all([consentProjection.initialize(), auditService.initialize()]).catch((error) => {
    logApiError('security_services.initialize', error);
    console.error('Security services failed initialization; protected actions will fail closed.');
  });
  consentProjection.startPolling();
  app.listen(port, '0.0.0.0', () => {
    console.log(`CyberSentinel API listening on port ${port}`);
  });
}

void start();