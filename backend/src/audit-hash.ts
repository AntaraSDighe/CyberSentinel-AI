import { createHash } from 'node:crypto';

export function sha256AuditHash(previousHash: string | null, sequence: number, payloadText: string): string {
  return createHash('sha256')
    .update(`${previousHash ?? ''}:${sequence}:${payloadText}`, 'utf8')
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}