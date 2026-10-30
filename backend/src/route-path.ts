export function normalizeApiPath(path: string): string {
  const normalized = path.toLowerCase().replace(/\/+$/, '');
  return normalized || '/';
}
