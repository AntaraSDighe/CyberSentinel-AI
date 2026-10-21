# CyberSentinel-AI

AI-powered security platform that protects sensitive data and AI agents using consent verification, a fail-closed gateway, SHA-256 audit logs, Gemini AI, and secure administrator approvals to prevent unauthorized access.

This repository contains a hackathon-ready implementation of Stages 1–6. Security-sensitive actions are decided by backend services; Gemini only provides advisory analysis and cannot authorize an operation.

## Requirements

- Node.js 20+ and npm 10+
- Supabase project for durable shared storage (optional for local exploration)
- Gemini API key for AI risk analysis (optional)
- SMTP or Telegram credentials and an OTP secret for administrator approvals (optional; exports stay denied without them)

## Run in Codespaces

```bash
npm install
cp .env.example .env
npm run dev
```

Codespaces should forward ports **5173** (React dashboard) and **3001** (Express API). Open port 5173. Vite proxies `/api` requests to the backend. Root `.env` values are loaded by the API and MCP server only; do not prefix server secrets with `VITE_` or place them in frontend code.

The dashboard uses the explicit local demo identity `demo-actor`. In-memory mode is clearly reported in the UI and health response; it is ephemeral and resets when the API restarts. It is suitable for a local demo, not durable data.

## Supabase setup

Set both server-only values in `.env`:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

Apply the SQL files in `supabase/migrations/` to the Supabase project, in filename order. They create/extend the expected `actor_profiles`, `consent_events`, `audit_events`, `audit_chain_heads`, `protected_files`, and `approval_requests` schemas, including consent/audit mutation guards and the serialized audit append function. If those tables already exist with a different schema, reconcile the migration with the existing columns before applying it. Restart the API after configuring Supabase. Both Supabase variables are required together; partial configuration prevents startup rather than silently falling back to memory.

The Supabase service-role key is privileged and must remain in the backend environment. Do not expose it to the Vite client. The example uses placeholders only.

## Consent and protected files

In **Consent Management**, grant the demo identity scopes before using protected pages:

- `files:register` to register metadata
- `files:read` to view/access metadata and its history
- `payments:export` to request a sensitive metadata export
- `audit:read` to list or verify audit history
- `approvals:read` to list approval requests

Consent history is append-only and replayed to derive current state. Revocation updates this API process immediately; the in-memory projection reconciles external database changes every second and denies protected actions if it is unavailable, inconsistent, or older than five seconds.

The browser calculates the selected file's SHA-256 fingerprint locally and sends only metadata and the digest. The backend rejects extra file fields. This application does not upload file contents or send them to Gemini. Browser-based metadata controls cannot stop other desktop applications from opening, copying, or modifying the local file.

## Gemini

Set `GEMINI_API_KEY` in the backend `.env` to enable the AI Risk Analysis page. Optionally set `GEMINI_MODEL` (defaults to `gemini-2.5-flash`). The backend uses the official Google GenAI SDK with function calling for consent checks, gateway evaluation, and consent-gated audit review. The operation description is sent to Google only after the user submits the form. Gemini results are advisory; an API authorization decision is always made separately by the backend gateway.

Without a key, `/api/ai/status` reports unavailable and the dashboard will not display a fabricated analysis.

## Administrator approvals

Exports are metadata-only and require an active `payments:export` consent plus a separate administrator OTP. Configure `OTP_SECRET` with at least 32 random characters and one delivery provider:

```bash
openssl rand -hex 32
```

For SMTP, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `ADMIN_EMAIL`. Or set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. The code is a random six-digit value, stored as an HMAC, sent only out-of-band, limited to five attempts, and valid for 60 seconds. Delivery failures, absent configuration, missing/invalid/expired OTPs, or revoked export consent all deny release. OTP values are never returned to the browser.

## MCP server

The official MCP SDK server uses stdio JSON-RPC and calls the running API, so it shares the same projection and storage. Start the API first, then run in a separate terminal:

```bash
npm run mcp
```

The server provides `check_consent`, `evaluate_access`, `review_audit_history`, `verify_audit_chain`, and `gateway_health`. Audit review and verification require `audit:read` consent. Set `CYBERSENTINEL_API_URL` if the API is not at `http://localhost:3001`.

## API

- `GET /api/health`
- `GET|POST /api/consents`, `GET /api/consents/:actorId/:scope`, and event history/revoke/expire routes
- `GET /api/gateway/health`, `POST /api/gateway/evaluate`
- `GET /api/audit?actorId=...`, `POST /api/audit/verify`
- `GET /api/files?actorId=...`, `POST /api/files`, file access and history routes
- `GET /api/ai/status`, `POST /api/ai/analyze`
- `GET /api/approvals/status`, approval request, OTP approval, and metadata release routes

## Verify

```bash
npm test
npm run build
```

Automated tests cover consent replay and revocation, fail-closed gateway behavior and zero-read hot-path decisions, five-second reconciliation under local test conditions, audit tamper/link/deletion detection, concurrent audit appends, protected-file access, AI/MCP authorization tools, and OTP secrecy/expiry/revocation.

## Scope and deployment warning

This is a local/hackathon implementation, not a production identity system. The dashboard's `demo-actor` is a fixed development identity and the API does not yet authenticate users or establish actor identities from a trusted identity provider. Do not expose it publicly or use real sensitive data until authentication, role administration, deployment secrets, network controls, backups, and operational monitoring are configured. In-memory storage is single-process and is not durable; use Supabase for shared state.