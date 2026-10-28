import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const rootEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));

dotenv.config({ path: rootEnvPath });