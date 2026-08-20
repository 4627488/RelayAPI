# Agent Note: Standard upstream quota windows

Status: implemented

## Problem

Quota probes already hit the community endpoints (Codex WHAM, Kimi `/usages`, xAI CLI billing), but they invented window kinds from labels, treated missing xAI percent or HTTP 412 as hard errors, and sent unofficial request headers. That drifted from CPA / sub2api / official kimi-cli and made parent-subscription calibration see unstable kinds.

## Decision

Keep the existing `QuotaReport` / `QuotaWindow` types and injectable endpoints. Split probes into `quota_codex.go`, `quota_kimi.go`, `quota_xai.go` plus shared HTTP/window helpers. Map only the documented windows:

- Codex WHAM `primary_window` → `5h`, `secondary_window` → `7d`, seconds 86400 → `1d`; require `chatgpt-account-id`; send `OpenAI-Beta: codex-1` and the Cloudflare-facing header set. Spark is display-only.
- Kimi official `usage` → `7d`, 300-minute `limits[]` → `5h`; `KimiCLI/1.3` fingerprint headers; plan from `user.membership.level`.
- xAI weekly from `creditUsagePercent` (0% when the period exists without a percent); monthly/prepaid display-only; plan from `subscriptionTier`; 412 / no personal team → `Supported: false`.

Do not invent kinds from Chinese labels, monthly-limit cents, or product-usage rows. Do not send a Grok `/responses` probe that burns quota.

## Alternatives considered

**Keep heuristic slug kinds.** Operators already have `5h`/`7d` child windows; invented slugs never calibrate.

**Copy sub2api’s active Grok “hi” probe.** It consumes subscription quota just to fill a missing percent. Billing-only matches the “额度窗口” request.

**Change inference `OpenAI-Beta` to `codex-1`.** Quota and Responses are different ChatGPT surfaces; inference stays `responses=experimental`.

## Consequences

Existing Kimi snapshots whose kind was a label slug will be re-observed as `7d`/`5h` on the next probe. Team-only xAI accounts stop showing probe errors and become “上游未提供自动额度”. Spark windows appear in the snapshot but do not enter parent-window calibration.
