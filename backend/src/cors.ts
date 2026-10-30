import type { RequestHandler } from 'express';

export function createCorsMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const configuredOrigin = env.CORS_ORIGIN?.trim();
  const allowedOrigin = configuredOrigin || (env.NODE_ENV === 'development' ? 'http://localhost:5173' : null);

  return (request, response, next) => {
    const requestOrigin = request.get('origin');
    const sameOrigin = `${request.protocol}://${request.get('host')}`;
    const originAllowed = requestOrigin && (
      requestOrigin === allowedOrigin ||
      (env.NODE_ENV !== 'development' && requestOrigin === sameOrigin)
    );
    if (requestOrigin && !originAllowed) {
      response.status(403).json({ error: 'Origin is not allowed' });
      return;
    }

    if (requestOrigin) {
      response.vary('Origin');
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.setHeader('Access-Control-Max-Age', '600');
    }

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  };
}
