import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const rootEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));

export function loadBackendEnvironment(
  path: string = rootEnvPath,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const target: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) target[key] = value;
  }
  dotenv.config({ path, processEnv: target });
  Object.assign(environment, target);
}