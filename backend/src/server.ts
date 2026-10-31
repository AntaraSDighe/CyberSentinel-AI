import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logApiError } from './errors.js';
import { initializeBackend } from './runtime.js';
import vercelHandler from './vercel-function.js';

const frontendIndexPath = fileURLToPath(new URL('../../frontend/dist/index.html', import.meta.url));
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

export default vercelHandler;

async function start(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && !existsSync(frontendIndexPath)) {
    throw new Error(`Production frontend build is missing at ${frontendIndexPath}; run the root build command before starting the service.`);
  }
  const { app } = await initializeBackend();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CyberSentinel API listening on port ${port}`);
  });
  server.on('error', (error) => {
    logApiError('server.listen', error);
    process.exitCode = 1;
  });
}

if (process.env.VERCEL !== '1') {
  void start().catch((error) => {
    logApiError('server.startup', error);
    process.exitCode = 1;
  });
}