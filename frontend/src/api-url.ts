export function getApiRequestUrl(path: string, mode: string, apiBaseUrl?: string): string {
  const baseUrl = mode === 'production' ? apiBaseUrl?.trim().replace(/\/+$/, '') : '';
  return baseUrl ? `${baseUrl}${path}` : path;
}
