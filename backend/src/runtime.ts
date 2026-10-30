import { loadBackendEnvironment } from './env.js';
import { getDevelopmentOtpConfigurationWarning } from './approval-delivery.js';
import { logApiError } from './errors.js';
import { setupDevelopmentDemoConsents } from './demo-setup.js';
import { validateProductionConfiguration } from './production-config.js';

export type BackendRuntime = typeof import('./app.js');

let runtimePromise: Promise<BackendRuntime> | undefined;

export function initializeBackend(): Promise<BackendRuntime> {
  runtimePromise ??= initialize();
  return runtimePromise;
}

async function initialize(): Promise<BackendRuntime> {
  loadBackendEnvironment();
  process.env.NODE_ENV ??= 'production';
  validateProductionConfiguration(process.env);

  const runtime = await import('./app.js');
  const {
    approvalService, auditService, consentProjection, consentService, geminiAnalyzer, platformStore,
  } = runtime;

  console.info(`Backend startup: pid=${process.pid} NODE_ENV=${process.env.NODE_ENV ?? 'unset'} OTP configured=${approvalService.status.otpConfigured} approval available=${approvalService.status.available} delivery=${approvalService.status.deliveryChannel ?? 'unavailable'}`);
  if (!platformStore.databaseConfigured) {
    console.warn(`Storage configuration: ${platformStore.configurationError}`);
  }
  if (!approvalService.status.available) {
    console.warn(`Approval configuration missing variables: ${[
      ...approvalService.status.missingVariableNames,
      ...approvalService.status.deliveryRequirementAlternatives.flat(),
    ].join(', ')}`);
  }
  const developmentOtpWarning = getDevelopmentOtpConfigurationWarning();
  if (developmentOtpWarning) console.warn(`Approval configuration: ${developmentOtpWarning}`);
  if (!geminiAnalyzer.available) {
    console.warn('AI configuration missing variables: GEMINI_API_KEY');
  }

  await Promise.all([consentProjection.initialize(), auditService.initialize()]).catch((error) => {
    logApiError('security_services.initialize', error);
    console.error('Security services failed initialization; protected actions will fail closed.');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Production security services failed initialization; refusing to start.');
    }
  });

  if (process.env.NODE_ENV === 'production') {
    await platformStore.verifySchema();
    const gateway = consentProjection.health();
    const audit = auditService.health();
    if (!gateway.ready || !gateway.consistent || !audit.ready || !audit.consistent) {
      throw new Error('Production database migrations or security data could not be verified; refusing to start.');
    }
  } else {
    try {
      const { grantedScopes, unavailableScopes } = await setupDevelopmentDemoConsents(
        process.env, consentService, auditService, consentProjection,
      );
      if (grantedScopes.length > 0) {
        console.info(`Development setup: recorded demo-actor consent grants for ${grantedScopes.join(', ')}.`);
      }
      if (unavailableScopes.length > 0) {
        console.warn(`Development demo consent: these scopes are ${unavailableScopes.join(', ')}; review them in Consent Management.`);
      }
      if (grantedScopes.length === 0 && unavailableScopes.length === 0 &&
        (process.env.DEMO_CONSENT_SETUP === 'false' ||
          (process.env.DEMO_CONSENT_SETUP === undefined && process.env.DEMO_GRANT_APPROVALS_READ === 'false'))) {
        console.info('Development demo consent setup is disabled by environment configuration.');
      }
    } catch (error) {
      logApiError('development.demo_consent', error);
      console.error('Development demo consent setup failed; protected actions remain denied until consent is available.');
    }
  }

  if (process.env.VERCEL !== '1') consentProjection.startPolling();
  return runtime;
}
