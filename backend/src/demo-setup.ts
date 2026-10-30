import type { AuditService } from './audit.js';
import type { ConsentService } from './consent.js';
import type { ConsentProjection } from './gateway.js';

const DEMO_ACTOR_ID = 'demo-actor';
const DEMO_SCOPES = ['audit:read', 'files:read', 'files:register', 'approvals:read'] as const;

export async function setupDevelopmentDemoConsents(
  env: NodeJS.ProcessEnv,
  consent: ConsentService,
  audit: AuditService,
  projection: ConsentProjection,
): Promise<{ grantedScopes: string[]; unavailableScopes: string[] }> {
  const demoSetupEnabled = env.DEMO_CONSENT_SETUP === undefined
    ? env.DEMO_GRANT_APPROVALS_READ !== 'false'
    : env.DEMO_CONSENT_SETUP === 'true';
  const enabled = env.NODE_ENV === 'development' && demoSetupEnabled;
  if (!enabled) return { grantedScopes: [], unavailableScopes: [] };

  const projectionHealth = projection.health();
  const auditHealth = audit.health();
  if (!projectionHealth.ready || !projectionHealth.consistent || !auditHealth.ready || !auditHealth.consistent) {
    throw new Error('Demo consent setup requires a verified consent projection and audit chain');
  }

  const grantedScopes: string[] = [];
  const unavailableScopes: string[] = [];
  for (const scope of DEMO_SCOPES) {
    const status = await consent.status(DEMO_ACTOR_ID, scope);
    if (status.status !== 'missing') {
      if (status.status !== 'granted') unavailableScopes.push(scope);
      continue;
    }

    const event = await consent.grant(DEMO_ACTOR_ID, scope);
    await audit.record({
      action: 'consent.granted',
      actorId: DEMO_ACTOR_ID,
      resource: scope,
      operation: 'development-demo-consent',
      decision: 'recorded',
      details: { consentEventId: event.id },
    });
    grantedScopes.push(scope);
  }

  await projection.refresh();
  const refreshedHealth = projection.health();
  if (!refreshedHealth.ready || !refreshedHealth.consistent || refreshedHealth.error) {
    throw new Error('Demo consent grants were recorded but the consent projection could not be verified');
  }

  return { grantedScopes, unavailableScopes };
}
