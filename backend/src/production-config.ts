import { getApprovalDeliveryRequirementAlternatives } from './approval-delivery.js';

const SECRET_PATTERN = /^[\x21-\x7E]+$/;

export function validateProductionConfiguration(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY']
    .filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Production configuration is missing required variables: ${missing.join(', ')}`);
  }

  if (env.DEV_OTP_DELIVERY?.trim().toLowerCase() === 'true') {
    throw new Error('Production configuration rejects DEV_OTP_DELIVERY=true; configure SMTP or Telegram OTP delivery.');
  }
  if (env.DEMO_AUTH?.trim().toLowerCase() === 'true') {
    throw new Error('Production configuration rejects demo authentication.');
  }
  if (env.DEMO_CONSENT_SETUP?.trim().toLowerCase() === 'true' ||
    env.DEMO_GRANT_APPROVALS_READ?.trim().toLowerCase() === 'true') {
    throw new Error('Production configuration rejects development demo consent setup.');
  }

  const otpSecret = env.OTP_SECRET?.trim() ?? '';
  const distinctCharacters = new Set(otpSecret).size;
  const strongHexSecret = /^[0-9a-f]{64,}$/i.test(otpSecret) && distinctCharacters >= 12;
  const strongRandomSecret = SECRET_PATTERN.test(otpSecret) && otpSecret.length >= 43 && distinctCharacters >= 24;
  if (!strongHexSecret && !strongRandomSecret) {
    throw new Error('Production OTP_SECRET must contain at least 256 bits of random material (for example, generate it with openssl rand -hex 32).');
  }
  if (isServiceRoleKey(env.SUPABASE_ANON_KEY!.trim())) {
    throw new Error('SUPABASE_ANON_KEY must be the public publishable/anon key, never a service-role key.');
  }

  function isServiceRoleKey(key: string): boolean {
    if (key.startsWith('sb_secret_')) return true;
    const payload = key.split('.')[1];
    if (!payload) return false;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role === 'service_role';
    } catch {
      return false;
    }
  }
  const corsOrigin = env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    let frontendOrigin: URL;
    try {
      frontendOrigin = new URL(corsOrigin);
    } catch {
      throw new Error('Production CORS_ORIGIN must be an exact HTTPS origin when configured.');
    }
    if (frontendOrigin.protocol !== 'https:' || frontendOrigin.origin !== corsOrigin ||
      frontendOrigin.username || frontendOrigin.password || frontendOrigin.pathname !== '/') {
      throw new Error('Production CORS_ORIGIN must be an exact HTTPS origin without a path when configured.');
    }
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.SUPABASE_URL!.trim());
  } catch {
    throw new Error('Production SUPABASE_URL must be a valid HTTPS Supabase project URL.');
  }
  if (databaseUrl.protocol !== 'https:' || databaseUrl.username || databaseUrl.password ||
    databaseUrl.pathname !== '/' || databaseUrl.search || databaseUrl.hash) {
    throw new Error('Production SUPABASE_URL must be a valid HTTPS Supabase project URL.');
  }

  const deliveryAlternatives = getApprovalDeliveryRequirementAlternatives(env);
  if (deliveryAlternatives.length > 0) {
    throw new Error(`Production requires SMTP or Telegram OTP delivery. Configure one complete group: ${deliveryAlternatives.map((group) => group.join(', ')).join(' OR ')}.`);
  }

  const smtpConfigured = Boolean(env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() &&
    env.SMTP_PASSWORD && env.SMTP_FROM?.trim() && env.ADMIN_EMAIL?.trim());
  if (smtpConfigured && env.SMTP_PORT?.trim()) {
    const port = Number(env.SMTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Production SMTP_PORT must be an integer between 1 and 65535.');
    }
  }
  if (env.SMTP_SECURE?.trim() && !['true', 'false'].includes(env.SMTP_SECURE.trim().toLowerCase())) {
    throw new Error('Production SMTP_SECURE must be true or false.');
  }
}
