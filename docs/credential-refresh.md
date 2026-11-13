# Codex credential refresh

Relay owns Codex OAuth refresh in `internal/upstream/native_provider.go`. It uses the credential's selected proxy and refreshes expired or undated access tokens before inference. HTTP 401 permits one refresh and retry on the same credential. A failed refresh stops the request; uncertain generation failures are never replayed automatically.

The token exchange uses the Codex client ID and `openid profile email` refresh scope. Rotated refresh tokens, ID token account identity and expiration are merged into the credential document. Persistence preserves database identity, published models, grants and proxy selection. Quota probes use the same runtime refresh entry point.

CPA and its fork are no longer runtime or module dependencies. Tests use isolated token endpoints and never real local sign-in files.
