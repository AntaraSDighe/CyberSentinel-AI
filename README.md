# CyberSentinel-AI

AI-assisted dashboard for consent-gated file metadata operations, a fail-closed gateway, SHA-256 audit logs, optional Gemini analysis, and administrator approvals. File registration records a local fingerprint and metadata; it is not malware scanning or operating-system file protection.

This repository contains a hackathon-ready implementation of Stages 1–6. Security-sensitive actions are decided by backend services; Gemini only provides advisory analysis and cannot authorize an operation.

## Requirements

- Node.js 20+ and npm 10+
- Supabase project for durable shared storage (optional for local exploration)
- Gemini API key for AI risk analysis (optional)
- SMTP or Telegram credentials and an OTP secret for administrator approvals (optional; exports stay denied without them)

## Run in Codespaces

```bash
npm install
test -f .env || cp .env.example .env
npm run dev
```

Codespaces forwards ports **5173** (React dashboard) and **3001** (Express API) privately using `.devcontainer/devcontainer.json`. Open the forwarded port 5173 URL. Vite proxies `/api` requests to the backend. `npm run dev` starts both services; if running them separately, use `npm run dev:backend` and `npm run dev:frontend`. The backend loads the repository-root `.env` from `backend/src/env.ts` before constructing the Gemini and approval services; shell-provided environment values take precedence. The API and MCP server load these values server-side only; do not prefix server secrets with `VITE_` or place them in frontend code. Check `/api/config/status` for missing variable names and provider alternatives; its response never includes configured values.

The root `.env.example` leaves optional credentials blank. In local development, missing Supabase credentials use ephemeral in-memory storage and the dashboard shows **Database not configured**. Production startup requires Supabase and never falls back to memory. If you start Vite by itself, `/api` requests return an upstream error until the backend is running on port 3001 (or the port configured by `PORT`).

The dashboard uses the explicit `demo-actor` identity only in local development. The backend accepts this unauthenticated demo identity only when `NODE_ENV=development` and never grants it administrator privileges. When `npm run dev` starts the backend, `DEMO_CONSENT_SETUP=true` appends audited grants for `audit:read`, `files:read`, `files:register`, and `approvals:read` only when each scope has no prior history. Revoked or expired scopes are never restored automatically, and the setup never grants `payments:export`. Production requires Supabase Auth and derives every actor ID from a verified access token. In-memory mode remains local-demo-only; production fails closed if persistent storage is unavailable.

## Supabase setup

Set the project URL and server-only service role key in `.env`. The anon key is public, but configure it only for authentication:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-public-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

For Codespaces, add the values under **Settings → Secrets and variables → Codespaces**. The service-role key is backend-only and must never use a `VITE_` prefix. `SUPABASE_ANON_KEY` is a public key; the production frontend build uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for browser Supabase Auth. Never commit `.env`. To restart the API, stop its terminal and run `npm run dev:backend` again; if using `npm run dev`, stop and rerun that command.

Apply every approved SQL file in `supabase/migrations/` to the Supabase project in filename order. In addition to the consent, audit, file, and approval objects, the migrations create the shared PostgreSQL rate-limit table and atomic counter function. Reconcile any live schema differences before applying SQL. Production verifies required tables at startup and refuses to use in-memory storage.

The Supabase service-role key is privileged and must remain in the backend environment. Do not expose it to the Vite client. The example uses placeholders only.

## Production deployment (Vercel)

The single-project setup uses the repository root (`.`) as its Root Directory. The root `vercel.json` runs the backend tests and both workspace builds, publishes `frontend/dist`, and declares `api/[...path].ts` as the Node.js function for `/api/*`. That function initializes and invokes the existing Express application, preserving its routes and middleware. The final rewrite sends non-file frontend routes to `index.html`; API paths are handled by the function. With this setup, leave `VITE_API_BASE_URL` unset so the browser uses same-origin `/api/...` requests.

For separate frontend and backend Vercel projects, set the backend project's Root Directory to `backend/`, use the Express preset, and leave Output Directory unset. The root `vercel.json` and root `api/[...path].ts` belong only to the single-project setup; the backend project's serverless entry point is `src/server.ts`, which delegates requests to the existing Express app. Set `VITE_API_BASE_URL` to the backend project's actual HTTPS origin in the frontend project's build environment, and set backend `CORS_ORIGIN` to the frontend project's exact HTTPS origin. Neither value should include a path or trailing slash. Local development continues to use relative requests and Vite's `/api` proxy with `npm run dev`.

### Before deploying

1. In Supabase, review and apply all approved SQL migrations in filename order, including:
   - `supabase/migrations/202610210001_consent_events.sql`
   - `supabase/migrations/202610210002_audit_chain.sql`
   - `supabase/migrations/202610210003_files_and_approvals.sql`
   - `supabase/migrations/202610300001_server_role_access.sql`
   - `supabase/migrations/202610300002_shared_rate_limits.sql`

   Reconcile schema differences before applying SQL. Migrations are not run automatically. The rate-limit migration creates the shared PostgreSQL buckets and atomic `consume_api_rate_limit` function. Its arguments are `p_bucket_hash`, `p_window_seconds`, and `p_maximum`, and its result columns are `allowed`, `retry_after_seconds`, and `remaining`. Production startup verifies the function and fails closed if it is missing or inaccessible; do not disable rate limiting to recover service.
2. For the single-project deployment, set Vercel's Root Directory to the repository root and Framework Preset to **Other**. The checked-in configuration uses `npm ci`, build command `npm test --workspace backend && npm run build`, and output directory `frontend/dist`. Keep the API function in the root `api/` directory.
3. Configure these Vercel environment variable names for the relevant Production deployment:
   - Required backend values: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, and `OTP_SECRET`.
   - Required frontend build values: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. These are public Supabase Auth settings, not secrets. `VITE_API_BASE_URL` is optional for same-origin deployment; for separate projects, set it to the backend project's actual HTTPS origin. Never put a server secret in a `VITE_` variable.
   - Configure one complete OTP delivery group: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `ADMIN_EMAIL`; **or** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. `SMTP_PORT` and `SMTP_SECURE` are optional.
   - `GEMINI_MODEL` and `CORS_ORIGIN` are optional for same-origin deployment. Set `CORS_ORIGIN` to the exact frontend HTTPS origin for separate projects.

   Add private credentials using Vercel's encrypted environment-variable settings; never commit them. Use a strong random `OTP_SECRET` (at least 256 bits). Production rejects demo authentication, development OTP delivery, and demo-consent setup. The function defaults `NODE_ENV` to production when Vercel has not set it.
4. Configure Supabase Auth email/password sign-in and its Site URL/redirect URLs for the actual Vercel origin. Admin privileges are not self-service: an authorized database operator must provision the verified Supabase Auth user ID with `role = 'admin'` in `actor_profiles`. No admin role-management endpoint exists; do not derive roles from user-editable metadata.

The production limiter hashes actor, IP, and sign-in-account keys with `OTP_SECRET`; raw email addresses and IP addresses are not stored. Limits are atomic and shared across serverless instances through Supabase PostgreSQL; storage errors return HTTP 503 rather than bypassing enforcement. Production OTPs are never printed to logs. Existing expiration, lockout, timing-safe OTP verification, consent checks, audit verification, and file ownership checks remain active.

### Build and health checks

The configured build runs:

```bash
npm test --workspace backend
npm run build
```

`/api/health/live` reports process availability. `/api/health` separately reports Supabase-backed database, gateway, and audit readiness plus Gemini configuration. Gemini availability means a key is configured; it does not prove that a live upstream model request succeeds.

## Consent and protected files

In **Consent Management**, grant the demo identity scopes before using protected pages:

- `files:register` to register metadata
- `files:read` to view/access metadata and its history
- `payments:export` to request a sensitive metadata export
- `audit:read` to list or verify audit history
- `approvals:read` to list approval requests

The demo dashboard uses actor `demo-actor`. Listing that actor's registered metadata requires `files:read`; registering file metadata requires `files:register`. Listing that actor's own approval requests requires `approvals:read`. These grants are actor- and scope-specific and do not provide access to another actor's records. `approvals:read` is not administrator authentication: an approval state change still requires the one-time code delivered through the configured administrator channel. The local demo identity is not a real authenticated user and must not be exposed publicly.

Consent history is append-only and replayed to derive current state. Revocation updates this API process immediately; the in-memory projection reconciles external database changes every second and denies protected actions if it is unavailable, inconsistent, or older than five seconds.

The browser calculates the selected file's SHA-256 fingerprint locally and sends only metadata and the digest. The backend rejects extra file fields. This application does not upload file contents or send them to Gemini. Browser-based metadata controls cannot stop other desktop applications from opening, copying, or modifying the local file.

## Gemini

Set `GEMINI_API_KEY` in the repository-root `.env` (loaded server-side by the backend) to enable the AI Risk Analysis page. Optionally set `GEMINI_MODEL` (defaults to `gemini-3.8-flash`). Missing keys produce an unavailable status in `/api/ai/status`, `/api/config/status`, and `/api/health`; these configuration endpoints report whether a key is present, not whether Google has accepted it. The key is never sent to the frontend. The backend uses the official Google GenAI SDK and requests validated JSON containing a 0–100 risk score, risk level, threat category, explanation, and recommended safety action. Submitted operation text is untrusted data and is analyzed without executing its instructions. Only that submitted description is sent to Google; file contents are never sent. Gemini results are advisory; an API authorization decision is always made separately by the backend gateway. Analysis failures return a stable error code and actionable message; backend diagnostics include only the error category, provider status, and model, never the API key or submitted text.

Without a key, `/api/ai/status` reports unavailable and the dashboard will not display a fabricated analysis.

## Administrator approvals

Exports are metadata-only and require active `payments:export` consent plus a separate administrator OTP. Viewing approval requests separately requires `approvals:read`; development startup sets that demo scope, along with `audit:read`, `files:read`, and `files:register`, only when each has no prior history. Configure `OTP_SECRET` with at least 32 random characters:

```bash
openssl rand -hex 32
```

For SMTP, set `SMTP_HOST`, `SMTP_PORT` (defaults to 587), `SMTP_SECURE` (`true` only for implicit TLS), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `ADMIN_EMAIL`. Or set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. In local development only, `DEV_OTP_DELIVERY=true` enables terminal delivery; run `npm run dev:backend` (or `npm run dev`) to set `NODE_ENV=development`. The six-digit OTP is printed only in the backend terminal. Setting `DEV_OTP_DELIVERY=true` while running production `npm start` does not enable the development provider. The code is random, stored as an HMAC, limited to five attempts, and valid for 60 seconds. Delivery failures, absent configuration, missing/invalid/expired OTPs, or revoked export consent all deny release. OTP values and `OTP_SECRET` are never returned to the browser. The approval status page reports missing configuration without exposing values.

To test the local approval flow, set `OTP_SECRET` in the repository-root `.env` to the output of `openssl rand -hex 32`, leave `DEV_OTP_DELIVERY=true`, stop any existing backend, then run `npm run dev:backend` from the repository root. Confirm `GET /api/approvals/status` reports `available: true` and `deliveryChannel: "development"`. Grant `files:register`, `files:read`, and `payments:export` in Consent Management, register a file with **Allow approved metadata export**, and request its export. The demo setup adds `approvals:read` for viewing requests. Retrieve the new six-digit OTP from the backend terminal running `npm run dev:backend`, enter it on Administrator Approvals, approve the request, then release the metadata. The OTP is not returned by the API. Without the OTP or any required consent, release remains denied. For deployment, configure SMTP or Telegram instead; never use terminal delivery outside local development.

## MCP server

The official MCP SDK server uses stdio JSON-RPC and calls the running API, so it shares the same projection and storage. Start the API first, then run in a separate terminal:

```bash
npm run mcp
```

The server provides `check_consent`, `evaluate_access`, `review_audit_history`, `verify_audit_chain`, and `gateway_health`. Protected tools use the authenticated user's identity and require active consent where applicable. Set `CYBERSENTINEL_API_URL` if the API is not at `http://localhost:3001` and provide a current Supabase access token as `CYBERSENTINEL_API_TOKEN`. Never commit the token; it expires and must be refreshed.

## API

- `GET /api/health`
- `POST /api/auth/sign-up`, `POST /api/auth/sign-in`, `POST /api/auth/refresh`, `GET /api/auth/me`
- Protected routes derive the actor from the verified bearer token; client-supplied actor IDs are never used as identity.
- `GET|POST /api/consents`, `GET /api/consents/:actorId/:scope`, and event history/revoke/expire routes
- `GET /api/gateway/health`, `POST /api/gateway/evaluate`
- `GET /api/audit?limit=...`, `POST /api/audit/verify`
- `GET /api/files`, `POST /api/files`, file access and history routes
- `GET /api/ai/status`, `POST /api/ai/analyze`
- `GET /api/approvals/status`, approval request, OTP approval, and metadata release routes

## Verify

```bash
npm test
npm run build
```

Automated tests cover consent replay and revocation, fail-closed gateway behavior and zero-read hot-path decisions, five-second reconciliation under local test conditions, audit tamper/link/deletion detection, concurrent audit appends, protected-file access, AI/MCP authorization tools, and OTP secrecy/expiry/revocation.

## Scope and deployment warning

The application now uses Supabase Auth for production identity and verifies every bearer token server-side. The local `demo-actor` is available only in development, is always a non-admin, and is never enabled in production. Administrator roles must be provisioned by an authorized operator directly in Supabase; the application has no role-management UI. Rate limits require the PostgreSQL migration and a healthy Supabase connection, and fail closed if shared storage is unavailable. Before public launch, configure Supabase Auth email deliverability/MFA policy, provision admins securely, apply and verify the migrations, and configure backups, monitoring, and incident response. Browser sessions use the Supabase JS client; as with other browser apps, XSS could compromise a signed-in session, so deploy a restrictive CSP and keep frontend dependencies patched.