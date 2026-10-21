import './env.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = (process.env.CYBERSENTINEL_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const server = new McpServer({ name: 'cybersentinel-security', version: '0.1.0' });

server.registerTool('check_consent', {
  description: 'Read current consent status from the shared backend. This does not grant access.',
  inputSchema: { actorId: identifier, scope: identifier },
}, async ({ actorId, scope }) => textResult(await api(`/api/consents/${encodeURIComponent(actorId)}/${encodeURIComponent(scope)}`)));

server.registerTool('evaluate_access', {
  description: 'Evaluate protected access using the shared fail-closed in-memory consent gateway.',
  inputSchema: { actorId: identifier, scope: identifier },
}, async ({ actorId, scope }) => textResult(await api('/api/gateway/evaluate', {
  method: 'POST', body: JSON.stringify({ actorId, scope }),
})));

server.registerTool('review_audit_history', {
  description: 'List recent audit history. Requires active audit:read consent for the supplied actor.',
  inputSchema: { actorId: identifier },
}, async ({ actorId }) => textResult(await api(`/api/audit?actorId=${encodeURIComponent(actorId)}&limit=50`)));

server.registerTool('verify_audit_chain', {
  description: 'Verify the SHA-256 audit chain. Requires active audit:read consent for the supplied actor.',
  inputSchema: { actorId: identifier },
}, async ({ actorId }) => textResult(await api('/api/audit/verify', {
  method: 'POST', body: JSON.stringify({ actorId }),
})));

server.registerTool('gateway_health', {
  description: 'Read readiness, consistency, and freshness for the shared consent projection.',
  inputSchema: {},
}, async () => textResult(await api('/api/gateway/health')));

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

async function api(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body,
  });
  const body = await response.json() as { error?: string };
  if (response.status === 403 && path === '/api/gateway/evaluate') return body;
  if (!response.ok) throw new Error(body.error ?? `CyberSentinel API returned ${response.status}`);
  return body;
}

await server.connect(new StdioServerTransport());