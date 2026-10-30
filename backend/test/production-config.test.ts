import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateProductionConfiguration } from '../src/production-config.js';

const validProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'public-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_server_only',
  GEMINI_API_KEY: 'server-only-gemini-key',
  CORS_ORIGIN: 'https://cybersentinel.example',
  OTP_SECRET: '0123456789abcdef'.repeat(4),
  TELEGRAM_BOT_TOKEN: 'server-only-telegram-token',
  TELEGRAM_CHAT_ID: 'admin-chat',
  DEV_OTP_DELIVERY: 'false',
  DEMO_CONSENT_SETUP: 'false',
};

describe('production configuration', () => {
  it('accepts complete production configuration with Telegram OTP delivery', () => {
    assert.doesNotThrow(() => validateProductionConfiguration(validProductionEnvironment));
  });

  it('accepts complete production configuration with SMTP OTP delivery', () => {
    const { TELEGRAM_BOT_TOKEN: _botToken, TELEGRAM_CHAT_ID: _chatId, ...smtpEnvironment } = validProductionEnvironment;
    assert.doesNotThrow(() => validateProductionConfiguration({
      ...smtpEnvironment,
      SMTP_HOST: 'smtp.example',
      SMTP_PORT: '587',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'server-only-smtp-password',
      SMTP_FROM: 'noreply@example.com',
      ADMIN_EMAIL: 'admin@example.com',
    }));
  });

  it('requires Supabase Auth, server-side database, and Gemini settings', () => {
    for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'] as const) {
      const { [key]: _removed, ...incomplete } = validProductionEnvironment;
      assert.throws(() => validateProductionConfiguration(incomplete), new RegExp(key));
    }
  });

  it('allows same-origin production without a separately configured CORS origin', () => {
    const { CORS_ORIGIN: _corsOrigin, ...sameOriginEnvironment } = validProductionEnvironment;
    assert.doesNotThrow(() => validateProductionConfiguration(sameOriginEnvironment));
  });

  it('rejects terminal OTP delivery in production', () => {
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, DEV_OTP_DELIVERY: 'true' }),
      /rejects DEV_OTP_DELIVERY=true/,
    );
  });

  it('rejects development consent bootstrap in production', () => {
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, DEMO_CONSENT_SETUP: 'true' }),
      /rejects development demo consent setup/,
    );
  });

  it('rejects demo authentication and a service-role key used as the public auth key', () => {
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, DEMO_AUTH: 'true' }),
      /rejects demo authentication/,
    );
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, SUPABASE_ANON_KEY: 'sb_secret_server_only' }),
      /public publishable\/anon key/,
    );
    const serviceRoleJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, SUPABASE_ANON_KEY: serviceRoleJwt }),
      /public publishable\/anon key/,
    );
  });

  it('requires a strong OTP secret', () => {
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, OTP_SECRET: 'weak-secret' }),
      /at least 256 bits/,
    );
    assert.throws(
      () => validateProductionConfiguration({ ...validProductionEnvironment, OTP_SECRET: 'a'.repeat(64) }),
      /at least 256 bits/,
    );
  });

  it('validates an optional exact HTTPS cross-origin frontend origin', () => {
    for (const origin of ['http://cybersentinel.example', 'https://cybersentinel.example/path', '*']) {
      assert.throws(
        () => validateProductionConfiguration({ ...validProductionEnvironment, CORS_ORIGIN: origin }),
        /exact HTTPS origin/,
      );
    }
  });

  it('rejects invalid SMTP configuration', () => {
    assert.throws(
      () => validateProductionConfiguration({
        ...validProductionEnvironment,
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_CHAT_ID: undefined,
        SMTP_HOST: 'smtp.example',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'server-only-smtp-password',
        SMTP_FROM: 'noreply@example.com',
        ADMIN_EMAIL: 'admin@example.com',
        SMTP_PORT: 'invalid',
      }),
      /SMTP_PORT must be an integer/,
    );
  });

  it('does not impose production requirements on development', () => {
    assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: 'development' }));
  });
});
