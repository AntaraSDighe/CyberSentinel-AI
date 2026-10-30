import type { Response } from 'express';

export function logApiError(operation: string, error: unknown): void {
  const diagnostic = error instanceof Error
    ? error as Error & { code?: unknown; status?: unknown; details?: unknown; hint?: unknown }
    : null;
  const code = typeof diagnostic?.code === 'string' && /^[A-Z0-9_.-]{1,32}$/i.test(diagnostic.code)
    ? diagnostic.code
    : undefined;
  const status = typeof diagnostic?.status === 'number' && Number.isInteger(diagnostic.status)
    ? diagnostic.status
    : undefined;
  const stack = diagnostic?.stack
    ?.split('\n')
    .slice(1, 9)
    .map((line) => sanitizeDiagnostic(line.trim()))
    .join('\n');
  console.error(JSON.stringify({
    event: 'api_error',
    operation,
    errorType: diagnostic?.name ?? 'UnknownError',
    errorMessage: sanitizeDiagnostic(diagnostic?.message ?? 'A non-Error value was thrown'),
    ...(code ? { errorCode: code } : {}),
    ...(status ? { httpStatus: status } : {}),
    ...(typeof diagnostic?.details === 'string' && diagnostic.details
      ? { errorDetails: sanitizeDiagnostic(diagnostic.details) }
      : {}),
    ...(typeof diagnostic?.hint === 'string' && diagnostic.hint
      ? { errorHint: sanitizeDiagnostic(diagnostic.hint) }
      : {}),
    ...(stack ? { stack } : {}),
  }));
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b(?:sb_secret_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g, '[SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [SECRET]')
    .replace(/\b(password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|service[_-]?role[_-]?key)\s*([:=])\s*("[^"]*"|'[^']*'|[^,\s;]+)/gi, '$1$2[REDACTED]')
    .replace(/(\bKey\s+\([^)]*\)=)\([^)]*\)/gi, '$1[REDACTED]')
    .replace(/(\bFailing row contains\s*)\([^)]*\)/gi, '$1[REDACTED]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '/[USER]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, '[NUMBER]');
}

export function sendApiError(
  response: Response,
  error: unknown,
  operation: string,
  status: number,
  publicMessage: string,
): void {
  if (status >= 500) logApiError(operation, error);
  response.status(status).json({ error: publicMessage });
}
