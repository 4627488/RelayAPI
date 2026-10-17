# Agent Note: Add restrained terminal presentation to rai

Status: implemented

## Problem

Human-oriented commands used uniform plain text, making successful checks, warnings, default models and remaining subscription capacity harder to scan. Downloads and browser approval could also appear idle. Machine-facing management JSON, credential output and agent streams already have useful contracts and must remain parseable.

## Decision

Add a small terminal presentation helper in [terminal.go](../../../../internal/rai/terminal.go), using the existing go-isatty dependency and enabling Windows virtual-terminal output when available. Decorate only recognized interactive terminals. Use semantic status markers, aligned fields, highlighted headings/default models, compact quota bars and a single transient progress line. NO_COLOR disables styling and TERM=dumb disables rich output. Redirected human output keeps its existing format; management JSON, credential printing and child process streams bypass the helper.

Download progress uses bytes actually read and the response Content-Length; unknown totals show bytes without percentages. An incomplete or oversized download cannot replace the existing executable. Browser approval shows a waiting label without inventing percentage completion. Progress has no animation goroutine, cursor hiding, alternate screen or event loop, and clears on completion or error. Decorated remote values have control characters removed before rendering.

## Alternatives considered

A full-screen TUI or animation framework adds state and dependencies without improving these short commands. Formatting arbitrary management JSON into tables would expand the CLI contract and risk breaking scripts, so it stays JSON. Always emitting ANSI corrupts pipelines and dumb terminals; automatic detection is the default instead.

## Consequences

Unsupported terminals gracefully retain plain output. Color is supplementary to textual labels and markers. Fixed compact bars remain readable in narrow terminals; full monetary values and reset times stay visible. The existing terminal detector is promoted to a direct dependency without changing its version. Windows runtime tests and Linux/macOS cross-builds cover the platform-specific terminal boundary. See [CLI documentation](../../../../docs/rai-cli.md).
