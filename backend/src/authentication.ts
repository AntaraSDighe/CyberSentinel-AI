import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthenticatedIdentity, IdentityProvider } from './identity.js';
import { normalizeApiPath } from './route-path.js';

declare global {
  namespace Express {
    interface Request {
      identity?: AuthenticatedIdentity;
    }
  }
}

export function createAuthenticationMiddleware(
  provider: IdentityProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  return async (request, response, next) => {
    const path = normalizeApiPath(new URL(request.originalUrl, 'http://localhost').pathname);
    if (isPublicPath(request.method, path) || !isKnownProtectedPath(request.method, path)) {
      next();
      return;
    }

    const authorization = request.get('authorization');
    if (!authorization && env.NODE_ENV === 'development' && env.DEMO_AUTH?.trim().toLowerCase() !== 'false') {
      request.identity = { id: 'demo-actor', email: null, role: 'user' };
      next();
      return;
    }
    const bearerParts = authorization?.trim().split(/\s+/);
    const token = bearerParts?.length === 2 && bearerParts[0].toLowerCase() === 'bearer'
      ? bearerParts[1]
      : undefined;
    if (!token) {
      response.status(401).json({ error: 'Authentication is required', code: 'AUTH_REQUIRED' });
      return;
    }
    if (!provider) {
      response.status(503).json({ error: 'Authentication is unavailable', code: 'AUTH_UNAVAILABLE' });
      return;
    }

    try {
      const identity = await provider.verifyAccessToken(token);
      if (!identity) {
        response.status(401).json({ error: 'Authentication token is invalid or expired', code: 'AUTH_INVALID' });
        return;
      }
      request.identity = identity.id === 'demo-actor' ? { ...identity, role: 'user' } : identity;
      next();
    } catch (error) {
      logAuthFailure('verify', error);
      response.status(503).json({ error: 'Authentication service is temporarily unavailable', code: 'AUTH_UNAVAILABLE' });
    }
  };
}

function logAuthFailure(operation: string, error: unknown): void {
  console.error(JSON.stringify({
    event: 'authentication_failure',
    operation,
    errorType: error instanceof Error ? error.name : 'UnknownError',
  }));
}

export function requireAdministrator(request: Request, response: Response, next: NextFunction): void {
  if (!request.identity) {
    response.status(401).json({ error: 'Authentication is required', code: 'AUTH_REQUIRED' });
    return;
  }
  if (request.identity.role !== 'admin' || request.identity.id === 'demo-actor') {
    response.status(403).json({ error: 'Administrator authorization is required', code: 'ADMIN_REQUIRED' });
    return;
  }
  next();
}

export function actorIdFor(request: Request): string {
  if (!request.identity) throw new Error('Authenticated identity is missing');
  return request.identity.id;
}

function isPublicPath(method: string, path: string): boolean {
  if (method === 'POST' && ['/api/auth/sign-up', '/api/auth/sign-in', '/api/auth/refresh'].includes(path)) return true;
  return method === 'GET' && [
    '/api/config/status',
    '/api/health',
    '/api/approvals/status',
    '/api/ai/status',
    '/api/gateway/health',
  ].includes(path);
}

function isKnownProtectedPath(method: string, path: string): boolean {
  if (path === '/api/auth/me') return method === 'GET';
  if (path === '/api/consents') return ['GET', 'POST'].includes(method);
  if (/^\/api\/consents\/[^/]+\/[^/]+(?:\/(?:events|revoke|expire))?$/.test(path)) {
    return method === 'GET' || method === 'POST';
  }
  if (path === '/api/gateway/evaluate') return method === 'POST';
  if (path === '/api/audit') return method === 'GET';
  if (path === '/api/audit/verify') return method === 'POST';
  if (path === '/api/ai/analyze') return method === 'POST';
  if (path === '/api/files') return ['GET', 'POST'].includes(method);
  if (/^\/api\/files\/[^/]+\/(?:history|access)$/.test(path)) return ['GET', 'POST'].includes(method);
  if (path === '/api/approvals') return method === 'GET';
  if (path === '/api/approvals/payment-export') return method === 'POST';
  if (/^\/api\/approvals\/[^/]+\/(?:approve|release)$/.test(path)) return method === 'POST';
  return false;
}
