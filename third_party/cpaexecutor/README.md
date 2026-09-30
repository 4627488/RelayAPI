# CPA embedding boundary

Relay owns admission, database credential IDs, per-credential grants and
accounting. CPA owns provider execution, OAuth, credential refresh, protocol
translation and provider usage interpretation. The bridge adapts these domains;
it must never let CPA select a different parent credential after Relay admission.

Use `sdk/config`, `sdk/api`, `sdk/cliproxy` model registry operations,
`sdk/cliproxy/auth`, `sdk/cliproxy/usage` and registered `sdk/translator` dispatch
where they provide the required contract. SDK aliases are the same CPA types, so
using them does not translate or duplicate configuration or model schemas.

## Remaining internal seams

| CPA package | Required capability missing from the public SDK |
| --- | --- |
| `internal/api` | Handler-only server construction. Public `Service.Run` starts its own listener, config watcher and auth-store loading. Relay already owns its loopback listener and database credential synchronization. |
| `internal/runtime/executor` | Built-in executor constructors and compatibility execution helpers. Service owns registration, but cannot currently preserve all Relay executor observations when auth/config updates rebind executors. |
| `internal/wsrelay` | WebSocket gateway construction and shutdown for the handler-only lifecycle. |
| `internal/registry` | Static provider/plan catalogs, static model lookup, image model type and catalog-refresh notifications. The public registry supports client registrations; its registration hook does not observe static catalog updates. |
| `internal/auth/codex` | Existing CPA JWT claim parser for plan-specific catalogs; Relay does not maintain a separate claim parser. |
| `internal/config` | `DisableImageGenerationMode` and enum constants are not re-exported. Isolated in `config_modes.go`. |
| `internal/cache` | Clear provider reasoning replay caches under heap pressure; session shutdown itself uses the public executor contract. |
| `internal/thinking`, `internal/util`, `internal/helps` | Upstream thinking, payload and response metadata rules needed by the compatible-provider Responses extension. CPA's compatible executor currently targets Chat Completions. |
| `internal/translator/codex/openai/chat-completions` | Converter with configuration update intent for the compatibility extension; public registered dispatch does not expose that intent. |

Do not replace the handler lifecycle with `Builder.Build` alone. Auth/model
synchronization is installed by Service's private lifecycle, and `Service.Run`
can replace a wrapped Codex executor because it tests for the concrete
`CodexAutoExecutor` type. A one-time wrapper registration loses provider timing
and attempt telemetry on later credential/config updates. A future Service
migration needs a supported executor observation/rebind seam, database auth
synchronization, and a listener/handler contract; verify hot updates and strict
credential pinning before deleting the existing lifecycle.

Keep the root and bridge CPA versions aligned. The two existing fork changes
(policy-aware credential refresh and snapshot isolation) remain until an upstream
equivalent preserves their contracts. This bridge does not introduce additional
CPA source patches.
