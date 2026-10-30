import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createApprovalDelivery,
  getApprovalDeliveryRequirementAlternatives,
  getDevelopmentOtpConfigurationWarning,
} from '../src/approval-delivery.js';

describe('approval OTP delivery configuration', () => {
  it('delivers OTPs to the terminal only in explicit development mode', async () => {
    const delivery = createApprovalDelivery({ NODE_ENV: 'development', DEV_OTP_DELIVERY: 'true' });
    const originalInfo = console.info;
    let output = '';
    console.info = (message?: unknown) => { output = String(message); };

    try {
      await delivery.send('123456', 'approval-id');
    } finally {
      console.info = originalInfo;
    }

    assert.equal(delivery.available, true);
    assert.equal(delivery.channel, 'development');
    assert.match(output, /development_otp_delivery/);
    assert.match(output, /123456/);
    assert.match(output, /Development only/);
  });

  it('does not enable terminal OTP delivery outside development mode', () => {
    const delivery = createApprovalDelivery({ NODE_ENV: 'production', DEV_OTP_DELIVERY: 'true' });

    assert.equal(delivery.available, false);
    assert.equal(delivery.channel, null);
  });

  it('does not enable terminal OTP delivery unless explicitly enabled', () => {
    const delivery = createApprovalDelivery({ NODE_ENV: 'development' });

    assert.equal(delivery.available, false);
    assert.equal(delivery.channel, null);
  });

  it('does not enable terminal OTP delivery when the backend is not in development mode', () => {
    const delivery = createApprovalDelivery({ DEV_OTP_DELIVERY: 'true' });

    assert.equal(delivery.available, false);
    assert.equal(delivery.channel, null);
    assert.match(getDevelopmentOtpConfigurationWarning({ DEV_OTP_DELIVERY: 'true' }) ?? '', /NODE_ENV=development/);
  });

  it('does not warn when development OTP delivery is correctly enabled', () => {
    assert.equal(getDevelopmentOtpConfigurationWarning({
      NODE_ENV: 'development',
      DEV_OTP_DELIVERY: 'true',
    }), null);
  });

  it('reports safe delivery variable alternatives and excludes development delivery in production', () => {
    assert.deepEqual(getApprovalDeliveryRequirementAlternatives({ NODE_ENV: 'development' }), [
      ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'ADMIN_EMAIL'],
      ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
      ['DEV_OTP_DELIVERY'],
    ]);
    assert.deepEqual(getApprovalDeliveryRequirementAlternatives({ NODE_ENV: 'production' }), [
      ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'ADMIN_EMAIL'],
      ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    ]);
    assert.deepEqual(getApprovalDeliveryRequirementAlternatives({
      NODE_ENV: 'development', DEV_OTP_DELIVERY: 'true',
    }), []);
  });
});
