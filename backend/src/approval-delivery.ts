import nodemailer from 'nodemailer';

export interface ApprovalDelivery {
  readonly available: boolean;
  readonly channel: 'smtp' | 'telegram' | 'development' | null;
  send(code: string, approvalId: string): Promise<void>;
}

export function getApprovalDeliveryRequirementAlternatives(env: NodeJS.ProcessEnv = process.env): string[][] {
  const smtpConfigured = Boolean(
    env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() && env.SMTP_PASSWORD && env.SMTP_FROM?.trim() && env.ADMIN_EMAIL?.trim(),
  );
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim());
  const developmentConfigured = env.NODE_ENV === 'development' && env.DEV_OTP_DELIVERY === 'true';
  if (smtpConfigured || telegramConfigured || developmentConfigured) return [];

  const alternatives = [
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'ADMIN_EMAIL'],
    ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  ];
  if (env.NODE_ENV === 'development') alternatives.push(['DEV_OTP_DELIVERY']);
  return alternatives;
}

export function getDevelopmentOtpConfigurationWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DEV_OTP_DELIVERY === 'true' && env.NODE_ENV !== 'development') {
    return 'DEV_OTP_DELIVERY is ignored unless NODE_ENV=development. Restart the backend with npm run dev:backend for local OTP testing.';
  }
  return null;
}

export function createApprovalDelivery(env: NodeJS.ProcessEnv = process.env): ApprovalDelivery {
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim();
  if (telegramToken && telegramChatId) {
    return {
      available: true,
      channel: 'telegram',
      async send(code, approvalId) {
        const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: telegramChatId, text: `CyberSentinel administrator approval\nRequest: ${approvalId}\nOTP: ${code}\nExpires in 60 seconds.` }),
        });
        if (!response.ok) throw new Error(`Telegram delivery failed (${response.status})`);
      },
    };
  }

  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  const from = env.SMTP_FROM?.trim();
  const to = env.ADMIN_EMAIL?.trim();
  if (host && user && password && from && to) {
    const transporter = nodemailer.createTransport({
      host,
      port: env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : 587,
      secure: env.SMTP_SECURE?.trim().toLowerCase() === 'true',
      auth: { user, pass: password },
    });
    return {
      available: true,
      channel: 'smtp',
      async send(code, approvalId) {
        await transporter.sendMail({
          from, to, subject: 'CyberSentinel administrator approval',
          text: `Approval request ${approvalId}\nOTP: ${code}\nThis code expires in 60 seconds.`,
        });
      },
    };
  }

  if (env.NODE_ENV === 'development' && env.DEV_OTP_DELIVERY === 'true') {
    return {
      available: true,
      channel: 'development',
      async send(code, approvalId) {
        console.info(JSON.stringify({
          event: 'development_otp_delivery',
          warning: 'Development only; do not use this delivery provider outside local development.',
          approvalId,
          otp: code,
          expiresInSeconds: 60,
        }));
      },
    };
  }

  return { available: false, channel: null, async send() { throw new Error('No approval delivery provider is configured'); } };
}