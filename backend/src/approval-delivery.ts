import nodemailer from 'nodemailer';

export interface ApprovalDelivery {
  readonly available: boolean;
  readonly channel: 'smtp' | 'telegram' | null;
  send(code: string, approvalId: string): Promise<void>;
}

export function createApprovalDelivery(env: NodeJS.ProcessEnv = process.env): ApprovalDelivery {
  const telegramToken = env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = env.TELEGRAM_CHAT_ID;
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

  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const password = env.SMTP_PASSWORD;
  const from = env.SMTP_FROM;
  const to = env.ADMIN_EMAIL;
  if (host && user && password && from && to) {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(env.SMTP_PORT ?? 587),
      secure: env.SMTP_SECURE === 'true',
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

  return { available: false, channel: null, async send() { throw new Error('No approval delivery provider is configured'); } };
}