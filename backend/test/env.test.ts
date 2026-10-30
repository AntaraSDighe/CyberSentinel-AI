import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadBackendEnvironment } from '../src/env.js';

describe('backend environment loading', () => {
  it('loads dotenv values before service configuration without overriding shell values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cybersentinel-env-'));
    try {
      const path = join(directory, '.env');
      await writeFile(path, 'NODE_ENV=production\nDEV_OTP_DELIVERY=true\n');
      const environment: NodeJS.ProcessEnv = { NODE_ENV: 'development' };

      loadBackendEnvironment(path, environment);

      assert.equal(environment.NODE_ENV, 'development');
      assert.equal(environment.DEV_OTP_DELIVERY, 'true');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
