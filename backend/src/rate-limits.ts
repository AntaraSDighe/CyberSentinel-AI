import { createHmac } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { ApplicationStore } from './storage.js';
import { normalizeApiPath } from './route-path.js';

interface RateLimitRule {
  name: string;
  subject: string;
  windowSeconds: number;
  maximum: number;
}

export interface RateLimitStorageFailure {
  code: string;
  message: string;
  diagnosticCode?: string;
  status?: number;
}

type RateLimitPhase = 'all' | 'ip' | 'identity';

export function createRateLimitMiddleware(
  store: Pick<ApplicationStore, 'consumeRateLimit'>,
  secret: string,
  phase: RateLimitPhase = 'all',
): RequestHandler {
  if (secret.length < 32) throw new Error('Rate limiting requires a secret of at least 32 characters');
  return async (request, response, next) => {
    const path = normalizeApiPath(new URL(request.originalUrl, 'http://localhost').pathname);
    const rules = rulesFor(request, path, phase);
    if (rules.length === 0 || request.method === 'OPTIONS') {
      next();
      return;
    }

    try {
      for (const rule of rules) {
        const bucketHash = createHmac('sha256', secret).update(`${rule.name}\0${rule.subject}`).digest('hex');
        const result = await store.consumeRateLimit(bucketHash, rule.windowSeconds, rule.maximum);
        if (!result.allowed) {
          response.setHeader('Retry-After', String(result.retryAfterSeconds));
          response.status(429).json({
            error: 'Too many requests. Please wait before trying again.',
            code: 'RATE_LIMITED',
            retryAfterSeconds: result.retryAfterSeconds,
          });
          return;
        }
      }
      next();
    } catch (error) {
      const failure = rateLimitStorageFailure(error);
      logRateLimitFailure(error, failure.diagnosticCode);
      response.status(503).json({
        error: failure.message,
        code: failure.code,
      });
    }
  };
}

export function rateLimitStorageFailure(error: unknown): RateLimitStorageFailure {
  const diagnostic = error instanceof Error
    ? error as Error & { code?: unknown; status?: unknown }
    : null;
  const diagnosticCode = typeof diagnostic?.code === 'string' &&
    /^[A-Z0-9_.-]{1,32}$/i.test(diagnostic.code)
    ? diagnostic.code
    : undefined;
  const status = typeof diagnostic?.status === 'number' && Number.isInteger(diagnostic.status)
    ? diagnostic.status
    : undefined;

  if (diagnosticCode === 'PGRST202') {
    return {
      code: 'RATE_LIMIT_RPC_NOT_FOUND',
      message: 'PostgREST cannot resolve public.consume_api_rate_limit with the expected arguments. Verify the shared rate-limit migration, public schema exposure, function signature, and schema cache.',
      diagnosticCode,
      status,
    };
  }
  if (diagnosticCode === 'PGRST203') {
    return {
      code: 'RATE_LIMIT_RPC_AMBIGUOUS',
      message: 'PostgREST found ambiguous consume_api_rate_limit functions. Remove conflicting overloads so the expected public function signature is unique.',
      diagnosticCode,
      status,
    };
  }
  if (diagnosticCode === 'PGRST106') {
    return {
      code: 'RATE_LIMIT_SCHEMA_NOT_EXPOSED',
      message: 'The public schema is not exposed by the Supabase Data API. Expose public in the project API settings before using shared rate limiting.',
      diagnosticCode,
      status,
    };
  }
  if (diagnosticCode === '42501' || diagnosticCode === 'PGRST301' ||
    status === 401 || status === 403) {
    return {
      code: 'RATE_LIMIT_STORAGE_PERMISSION_DENIED',
      message: 'Supabase denied access to shared rate-limit storage. Verify the backend service-role credential and function permissions.',
      diagnosticCode,
      status,
    };
  }
  return {
    code: 'RATE_LIMIT_STORAGE_UNAVAILABLE',
    message: 'Shared rate-limit storage could not be reached. Check the Supabase connection and backend configuration.',
    diagnosticCode,
    status,
  };
}

function rulesFor(request: Request, path: string, phase: RateLimitPhase): RateLimitRule[] {
  const publicPaths = [
    '/api/config/status',
    '/api/health',
    '/api/approvals/status',
    '/api/ai/status',
    '/api/gateway/health',
  ];
  if (request.method === 'GET' && publicPaths.includes(path)) return [];

  const ip = request.ip || request.socket.remoteAddress || 'unknown';
  const actor = request.identity?.id;
  const rules: RateLimitRule[] = [
    { name: 'api:ip', subject: ip, windowSeconds: 60, maximum: 300 },
  ];
  if (actor) rules.push({ name: 'api:actor', subject: actor, windowSeconds: 60, maximum: 120 });

  if (path === '/api/auth/sign-in' || path === '/api/auth/sign-up') {
    const signIn = path.endsWith('sign-in');
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 320) : 'missing';
    rules.push(
      { name: `${signIn ? 'sign-in' : 'sign-up'}:ip`, subject: ip, windowSeconds: signIn ? 900 : 3600, maximum: signIn ? 20 : 10 },
      { name: `${signIn ? 'sign-in' : 'sign-up'}:account`, subject: email, windowSeconds: signIn ? 900 : 3600, maximum: signIn ? 5 : 3 },
    );
    return filterPhase(rules, phase);
  }

  if (path === '/api/auth/refresh') {
    rules.push({ name: 'auth:refresh:ip', subject: ip, windowSeconds: 3600, maximum: 60 });
    return filterPhase(rules, phase);
  }

  if (path === '/api/approvals/payment-export') {
    if (actor) rules.push({ name: 'otp:request:actor', subject: actor, windowSeconds: 900, maximum: 3 });
    rules.push({ name: 'otp:request:ip', subject: ip, windowSeconds: 3600, maximum: 10 });
    return filterPhase(rules, phase);
  }

  if (/^\/api\/approvals\/[0-9a-f-]{36}\/approve$/i.test(path)) {
    if (actor) rules.push({ name: 'otp:verify:actor', subject: actor, windowSeconds: 900, maximum: 5 });
    rules.push({ name: 'otp:verify:ip', subject: ip, windowSeconds: 900, maximum: 10 });
    return filterPhase(rules, phase);
  }

  if (path === '/api/ai/analyze') {
    if (actor) rules.push({ name: 'ai:actor', subject: actor, windowSeconds: 60, maximum: 10 });
    rules.push({ name: 'ai:ip', subject: ip, windowSeconds: 60, maximum: 30 });
  }
  return filterPhase(rules, phase);
}

function logRateLimitFailure(error: unknown, diagnosticCode?: string): void {
  const diagnostic = error instanceof Error
    ? error as Error & { status?: unknown }
    : null;
  const status = typeof diagnostic?.status === 'number' && Number.isInteger(diagnostic.status)
    ? diagnostic.status
    : undefined;
  console.error(JSON.stringify({
    event: 'rate_limit_store_failure',
    errorType: error instanceof Error ? error.name : 'UnknownError',
    ...(diagnosticCode ? { errorCode: diagnosticCode } : {}),
    ...(status ? { httpStatus: status } : {}),
  }));
}

function filterPhase(rules: RateLimitRule[], phase: RateLimitPhase): RateLimitRule[] {
  if (phase === 'all') return rules;
  return rules.filter((rule) => phase === 'ip'
    ? rule.name.endsWith(':ip') || rule.name.endsWith(':account')
    : rule.name.endsWith(':actor'));
}
