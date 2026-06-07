# Third-Party References

This rewrite references behavior from these upstream projects and APIs:

- OpenAI Codex CLI: https://github.com/openai/codex
- Previous RelayAPI TypeScript implementation in this repository history
- CLIProxyAPI Codex OAuth behavior referenced by the previous implementation as `internal/auth/codex/openai_auth.go GenerateAuthURL`

The Rust server does not directly vendor or link OpenAI Codex internal crates. The intent is to implement a minimal RelayAPI-specific Codex adapter while keeping protocol constants, OAuth parameters, and streaming behavior aligned with upstream behavior.

When adding copied or substantially derived code, preserve the upstream license notice in the touched module and update this file.
