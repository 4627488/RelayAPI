# RelayAPI Rust Rewrite

RelayAPI is being rewritten as a separated Rust backend and Vite frontend.

This branch intentionally removes the old Next.js/Bun implementation.

## Architecture

- `server/`: Rust API and relay service built with Axum, Tokio, SeaORM, Reqwest, and SQLite.
- `web/`: Vite + React + TypeScript admin console.
- `docker-compose.yml`: single-service deployment. The Rust server serves both API traffic and the built Vite admin console.

## Current Status

The rewrite foundation is in place:

- Health endpoint: `GET /api/health`
- Overview endpoint: `GET /api/admin/overview`
- Models endpoint: `GET /v1/models`
- Responses relay boundary: `POST /v1/responses`
- Compact responses relay boundary: `POST /v1/responses/compact`
- Chat completions compatibility boundary: `POST /v1/chat/completions`
- Codex OAuth start/callback boundary
- Redesigned single SQLite database, managed through SeaORM entities and raw startup migrations
- Encrypted Codex token storage using a local RelayAPI secret
- Web access key login with an HTTP-only session cookie
- Relay API key creation and authentication
- Channel selection and credential-backed Codex request forwarding
- Basic request logging and quota refresh endpoint

The next work is to finish advanced tenant isolation, full image endpoint compatibility, richer quota normalization, and the complete admin/tenant UI parity.

## Local Development

Run the Rust server:

```bash
cargo run -p relay-api-server
```

Run the frontend:

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173`.

## Docker

```bash
docker compose up --build
```

- App: `http://localhost:3000`

## Important Environment Variables

- `PORT`: backend port, default `3000`
- `DATA_DIR`: SQLite and local secret data directory, default `data`
- `RELAY_DB_PATH`: optional SQLite path, default `DATA_DIR/relay.sqlite`
- `RELAY_WEB_ACCESS_KEY` or `WEB_ACCESS_KEY`: fixed web access key. If omitted, a `relay_web_...` key is generated once and printed at startup.
- `RELAY_ENCRYPTION_KEY` or `RELAY_SECRET`: fixed encryption secret. If omitted, a local secret is generated under `DATA_DIR`.
- `CODEX_BASE_URL`: default `https://chatgpt.com/backend-api/codex`
- `CODEX_REDIRECT_URI`: default `http://localhost:1455/auth/callback`
- `CODEX_DEFAULT_MODEL`: default `gpt-5.3-codex`
- `CODEX_USER_AGENT`: defaults to a Codex CLI compatible user agent
- `RELAY_COOKIE_SECURE`: controls the `Secure` flag on session cookies, default `true`. Set to `false` only for plain-HTTP local development.
- `RELAY_CORS_ORIGINS`: comma-separated allowed browser origins. If omitted, the backend does not add permissive CORS headers.
- `RELAY_STATIC_DIR`: optional directory for static frontend assets. The production Docker image sets this to the built Vite output.

## Upstream Alignment

The Codex adapter is intentionally modeled as `server/src/upstream/codex` instead of being scattered through route handlers. Protocol behavior should be validated against OpenAI Codex CLI and documented in code comments/tests before expanding functionality.
