import type { Response } from 'express';

export function logApiError(operation: string, error: unknown): void {
  const diagnostic = error instanceof Error ? error as Error & { code?: unknown } : null;
  const code = typeof diagnostic?.code === 'string' && /^[A-Z0-9_.-]{1,32}$/i.test(diagnostic.code)
    ? diagnostic.code
    : undefined;
  console.error(JSON.stringify({
    event: 'api_error',
    operation,
    errorType: diagnostic?.name ?? 'UnknownError',
    ...(code ? { errorCode: code } : {}),
  }));
}

export function sendApiError(
  response: Response,
  error: unknown,
  operation: string,
  status: number,
  publicMessage: string,
): void {
  logApiError(operation, error);
  response.status(status).json({ error: publicMessage });
}
