import { loadBackendEnvironment } from './env.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

loadBackendEnvironment();

const baseUrl = normalizeApiUrl(process.env.CYBERSENTINEL_API_URL ?? 'http://localhost:3001');
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const apiToken = process.env.CYBERSENTINEL_API_TOKEN?.trim();
const server = new McpServer({ name: 'cybersentinel-security', version: '0.1.0' });

server.registerTool('check_consent', {
  description: 'Read consent status for the authenticated user. This does not grant access.',
  inputSchema: { scope: identifier },
}, async ({ scope }) => {
  const actorId = await currentActorId();
  return textResult(await api(`/api/consents/${encodeURIComponent(actorId)}/${encodeURIComponent(scope)}`));
});

server.registerTool('evaluate_access', {
  description: 'Evaluate access for the authenticated user using the shared fail-closed consent gateway.',
  inputSchema: { scope: identifier },
}, async ({ scope }) => textResult(await api('/api/gateway/evaluate', {
  method: 'POST', body: JSON.stringify({ scope }),
})));

server.registerTool('review_audit_history', {
  description: 'List recent audit history for the authenticated user. Requires active audit:read consent.',
  inputSchema: {},
}, async () => textResult(await api('/api/audit?limit=50')));

server.registerTool('verify_audit_chain', {
  description: 'Verify the SHA-256 audit chain for the authenticated user. Requires active audit:read consent.',
  inputSchema: {},
}, async () => textResult(await api('/api/audit/verify', {
  method: 'POST', body: JSON.stringify({}),
})));

server.registerTool('gateway_health', {
  description: 'Read readiness, consistency, and freshness for the shared consent projection.',
  inputSchema: {},
}, async () => textResult(await api('/api/gateway/health')));

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

async function api(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
  const body = await response.json() as { error?: string };
  if (response.status === 403 && path === '/api/gateway/evaluate') return body;
  if (!response.ok) throw new Error(body.error ?? `CyberSentinel API returned ${response.status}`);
  return body;
}

async function currentActorId(): Promise<string> {
  const body = await api('/api/auth/me') as { user?: { id?: unknown } };
  if (typeof body.user?.id !== 'string') throw new Error('Authenticated user identity is unavailable');
  return body.user.id;
}

function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localHost && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('CYBERSENTINEL_API_URL must use HTTPS except for a local development server.');
  }
  return url.toString().replace(/\/$/, '');
}

await server.connect(new StdioServerTransport());