# RelayAPI distribution

The standard deployment contains only RelayAPI and PostgreSQL. The Relay image
includes the Go API, native provider runtime and built React application; no
sidecar proxy, bridge image, C ABI plugin or third-party executor module is
required.

CI publishes Linux AMD64/ARM64 images. Production should pin a full release or
immutable `sha-*` tag. The deployment workflow verifies `/healthz` and rolls
back to the prior image if the new instance fails readiness.

```bash
docker compose pull
docker compose up -d
```

Persistent state is the PostgreSQL volume plus the secrets in `.env`. Back up
`RELAY_API_KEY_ENCRYPTION_KEY`; changing it prevents existing encrypted
credential and API-key material from being opened.
