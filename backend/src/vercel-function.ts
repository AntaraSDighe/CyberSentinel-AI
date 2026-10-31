import type { IncomingMessage, ServerResponse } from 'node:http';
import { logApiError } from './errors.js';
import { initializeBackend, type BackendRuntime } from './runtime.js';

type FunctionRuntime = Pick<BackendRuntime, 'app'> & {
  consentProjection: Pick<BackendRuntime['consentProjection'], 'refresh'>;
};
type RuntimeInitializer = () => Promise<FunctionRuntime>;

export function createVercelHandler(
  initialize: RuntimeInitializer = initializeBackend,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const runtime = await initialize();
      await runtime.consentProjection.refresh();
      runtime.app(request, response);
    } catch (error) {
      logApiError('vercel.function.initialize', error);
      if (!response.headersSent) {
        response.statusCode = 503;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          error: 'Backend services are unavailable; check Supabase configuration and required migrations.',
          code: 'BACKEND_UNAVAILABLE',
        }));
      }
    }
  };
}

export default createVercelHandler();
