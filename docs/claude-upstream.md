# Claude upstream support

Claude inference runs through the embedded CPA executor. Relay owns credential selection, account proxies, quota observation, parent/child allocation and settlement. OAuth subscriptions and Anthropic API keys remain distinct account types.

## Capability coverage

| Capability | Behavior |
| --- | --- |
| Messages, streaming and tool use | Existing CPA Messages executor and protocol conversion; no new inference probe is sent. |
| OAuth and refresh | CPA owns login/refresh. A proactive refresh failure stops the probe; otherwise usage HTTP 401 permits one forced refresh and retry. |
| Account proxy | The selected credential proxy applies to both usage and profile requests. |
| Subscription discovery | `GET https://api.anthropic.com/api/oauth/profile` supplies the token's organization plan, rate-limit tier, subscription status, billing type and extra-usage enablement. |
| Personal and organization plans | `free`, `pro`, `max`, `team`, `enterprise`; the token's organization takes precedence over personal account flags. Max 5x/20x stays in `subscription.rate_limit_tier`, separate from `plan_type=max`. |
| Account usage | `GET https://api.anthropic.com/api/oauth/usage`; active structured `session` / `weekly_all` limits take precedence over legacy five-hour / seven-day fields. Percentages retain upstream units, including values below 1%. An explicitly inactive structured account limit makes its legacy equivalent display-only. |
| Model usage | `seven_day_*` and active `limits[]` rows with `kind=weekly_scoped` are display-only; a model-specific limit never blocks all models. |
| Extra usage | `monthly_limit` and `used_credits` are minor currency units, converted with `decimal_places` when supplied (default 2), into the supplied currency (default USD). Null limits remain unknown; disabled extra usage and spend without a finite limit remain visible. |
| Independent credit pools | Rows with dollar amount fields preserve their own pool identity, dollar amounts and resets. These are separate from extra-usage cents. |
| Setup tokens | Explicit scopes without `user:profile` return `unsupported` / `missing_profile_scope` without calling account endpoints. Documents without scope metadata are still probed. |
| API keys | Subscription endpoints are not called for API-key-only accounts; subscription quota is unsupported, with no invented API balance. |
| Query throttling | Existing shared manual/background schedule, five-minute Claude observation cache, exponential failure backoff and upstream `Retry-After`. |

## Authorization lifecycle

OAuth capture returns a document to the Relay session, not a fictitious CPA file path. Finalization owns the same per-credential slot as manual and background probes. It waits for an old probe to finish before reading/replacing credentials, activates the new document, and immediately probes with the new authorization, bypassing the old cache and failure backoff. Background batches re-read the parent inside the slot, so a batch listed before reauthorization cannot restore stale state. The finalize response includes `quota_sync`: a failed quota probe does not roll back a valid authorization, and the UI reports the two outcomes separately.

OAuth expiry and refresh timestamps come from the current credential document, with a newer runtime refresh timestamp taking precedence. Access-token expiry is labeled separately from subscription benefits; a refreshable token reaching its expiry does not by itself disable scheduling. Reauthorization does not retain the old token's expiry.

## Independent observations

The normalized quota snapshot contains optional `subscription` metadata with its own `status`, `source`, bounded `error_code`, `checked_at` and successful `observed_at`. Successful profile results replace stale credential plan hints, including clearing a product that is no longer recognized. Later profile failures retain the last confirmed product and its observation time, while exposing the latest attempt's failure. Credential hints are used only until a confirmed profile is available. Profile results remain authoritative independently of usage success.

The management view displays Max 5x/20x directly and labels canceled subscriptions without inventing a benefits expiry. It shows the actual profile observation time instead of calling a stored snapshot live. Older snapshots without that timestamp do not receive an invented freshness label.

A profile request has a three-second timeout inside the existing probe budget. Profile failure does not discard successful usage, refresh a token that just fetched usage successfully, disable inference, or create fake capacity. Conversely, when usage fails but profile succeeds, Relay updates the subscription metadata while retaining the previous usage windows, `observed_at` and `quota_observed_at`. Usage remains in the error state and continues to back off. An expired five-hour generation cannot be released by a profile-only success.

The snapshot retains only product metadata, normalized windows and query status. It excludes profile account/organization UUIDs, names, emails, tokens and raw profile error bodies. It does not infer subscription expiry or renewal from quota reset dates, or use observed dollar balances to grant local parent capacity.

## Verification and boundaries

Fixture tests cover plan upgrades, organization precedence, free/unknown plans, independent usage/profile failures, scope capability, percent/amount units, null/zero limits, model-scoped limits, independent dollar pools, snapshot privacy and retaining usage generations during metadata updates. Browser tests cover live/stale plan display, partial snapshots, missing permissions and extra-usage amounts. The existing CPA parity tests cover Messages and translated OpenAI requests, streaming and canonical usage.

No real subscription account is required by these tests. Live compatibility, upstream schema changes, TLS/WAF behavior and plan-specific availability still require verification with an authorized account. This change does not redeem reset credits, change spending limits, switch organizations or simulate paid inference to obtain quota. Model-specific observations do not currently create separate model admission budgets.

## References

The implementation was compared with [Sub2API account usage](https://github.com/Wei-Shaw/sub2api/blob/dba770d56a0ee0ae5bad1b3dc5e11614d323163c/backend/internal/service/account_usage_service.go) and its [Claude usage fetcher](https://github.com/Wei-Shaw/sub2api/blob/dba770d56a0ee0ae5bad1b3dc5e11614d323163c/backend/internal/repository/claude_usage_service.go), plus CPA Management Center's [Claude provider](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/features/quota/providers/claude/data.ts), [usage normalization](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/services/api/claudeUsage.ts) and [wire types](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/types/quota.ts). Relay retains its existing PostgreSQL quota and settlement architecture.
