import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConsentStore, MemoryConsentStore } from '../src/storage.js';

describe('createConsentStore', () => {
  it('uses ephemeral in-memory storage when both Supabase values are absent', () => {
    const store = createConsentStore({});

    assert.ok(store instanceof MemoryConsentStore);
    assert.equal(store.databaseConfigured, false);
  });

  it('rejects partial Supabase configuration with a safe message', () => {
    assert.throws(
      () => createConsentStore({ SUPABASE_URL: 'https://project.supabase.co' }),
      { message: 'Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to enable Supabase storage' },
    );
  });

  it('rejects an invalid project URL without echoing its value', () => {
    assert.throws(
      () => createConsentStore({ SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }),
      { message: 'SUPABASE_URL must be a valid HTTP(S) URL' },
    );
  });

  it('rejects an unrecognized service key format without echoing its value', () => {
    assert.throws(
      () => createConsentStore({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'not-a-service-key' }),
      { message: 'SUPABASE_SERVICE_ROLE_KEY is not in a recognized Supabase key format' },
    );
  });

  it('accepts current and legacy Supabase key formats', () => {
    assert.equal(createConsentStore({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    }).databaseConfigured, true);
    assert.equal(createConsentStore({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'header.payload.signature',
    }).databaseConfigured, true);
  });
});