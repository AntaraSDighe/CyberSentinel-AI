import { Router } from 'express';
import type { IdentityProvider } from './identity.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthRouter(provider: IdentityProvider | null): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/sign-up', async (request, response) => {
    const { email, password } = request.body ?? {};
    if (!validEmail(email) || !validPassword(password) || password.length < 12) {
      return response.status(400).json({ error: 'A valid email and a password of at least 12 characters are required' });
    }
    if (!provider) return response.status(503).json({ error: 'Authentication is unavailable', code: 'AUTH_UNAVAILABLE' });
    try {
      const session = await provider.signUp(email.trim().toLowerCase(), password);
      if (!session) return response.status(202).json({ needsEmailConfirmation: true });
      response.status(201).json({ session });
    } catch (error) {
      logAuthFailure('sign_up', error);
      const status = providerFailureStatus(error, 400);
      response.status(status).json({
        error: status === 429 ? 'Authentication provider is rate limiting account creation. Please wait and retry.'
          : status === 503 ? 'Authentication is temporarily unavailable'
            : 'Unable to create account. Check the email and password requirements.',
        code: status === 429 ? 'AUTH_RATE_LIMITED' : status === 503 ? 'AUTH_UNAVAILABLE' : 'SIGN_UP_FAILED',
      });
    }
  });

  router.post('/sign-in', async (request, response) => {
    const { email, password } = request.body ?? {};
    if (!validEmail(email) || !validPassword(password)) {
      return response.status(400).json({ error: 'A valid email and password are required' });
    }
    if (!provider) return response.status(503).json({ error: 'Authentication is unavailable', code: 'AUTH_UNAVAILABLE' });
    try {
      response.json({ session: await provider.signIn(email.trim().toLowerCase(), password) });
    } catch (error) {
      logAuthFailure('sign_in', error);
      const status = providerFailureStatus(error, 401);
      response.status(status).json({
        error: status === 429 ? 'Authentication provider is rate limiting sign-in. Please wait and retry.'
          : status === 503 ? 'Authentication is temporarily unavailable'
            : 'Email or password is incorrect',
        code: status === 429 ? 'AUTH_RATE_LIMITED' : status === 503 ? 'AUTH_UNAVAILABLE' : 'INVALID_CREDENTIALS',
      });
    }
  });

  router.post('/refresh', async (request, response) => {
    const refreshToken = request.body?.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 4096) {
      return response.status(400).json({ error: 'A valid refresh token is required' });
    }
    if (!provider) return response.status(503).json({ error: 'Authentication is unavailable', code: 'AUTH_UNAVAILABLE' });
    try {
      response.json({ session: await provider.refresh(refreshToken) });
    } catch (error) {
      logAuthFailure('refresh', error);
      const status = providerFailureStatus(error, 401);
      response.status(status).json({
        error: status === 429 ? 'Authentication provider is rate limiting session refresh. Please retry shortly.'
          : status === 503 ? 'Authentication is temporarily unavailable'
            : 'Session could not be refreshed; sign in again',
        code: status === 429 ? 'AUTH_RATE_LIMITED' : status === 503 ? 'AUTH_UNAVAILABLE' : 'SESSION_REFRESH_FAILED',
      });
    }
  });

  router.get('/me', (request, response) => {
    if (!request.identity) return response.status(401).json({ error: 'Authentication is required', code: 'AUTH_REQUIRED' });
    response.json({ user: { id: request.identity.id, email: request.identity.email }, role: request.identity.role });
  });

  return router;
}

function logAuthFailure(operation: string, error: unknown): void {
  console.error(JSON.stringify({
    event: 'authentication_failure',
    operation,
    errorType: error instanceof Error ? error.name : 'UnknownError',
  }));
}

function validEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 320 && emailPattern.test(email.trim());
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0 && password.length <= 1024;
}

function providerFailureStatus(error: unknown, invalidRequestStatus: number): number {
  const status = typeof error === 'object' && error !== null && 'status' in error &&
    typeof error.status === 'number' ? error.status : null;
  if (status === 429) return 429;
  if (status !== null && (status === 0 || status >= 500)) return 503;
  return invalidRequestStatus;
}
