import type { IncomingMessage, ServerResponse } from 'node:http';
import { initializeBackend, type BackendRuntime } from '../backend/src/runtime.js';
import { logApiError } from '../backend/src/errors.js';

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
