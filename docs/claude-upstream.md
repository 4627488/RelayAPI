# Claude upstream support

Claude inference runs through the embedded CPA executor. Relay owns credential selection, account proxies, quota observation, parent/child allocation and settlement. OAuth subscriptions and Anthropic API keys remain distinct account types.

## Capability coverage

| Capability | Behavior |
| --- | --- |
| Messages, streaming and tool use | Existing CPA Messages executor and protocol conversion; no new inference probe is sent. |
| OAuth and refresh | Existing CPA login/refresh flow; proactive refresh and one bounded quota retry after usage HTTP 401. |
| Account proxy | The selected credential proxy applies to both usage and profile requests. |
| Subscription discovery | `GET https://api.anthropic.com/api/oauth/profile` supplies the token's organization plan, rate-limit tier, subscription status, billing type and extra-usage enablement. |
| Personal and organization plans | `free`, `pro`, `max`, `team`, `enterprise`; the token's organization takes precedence over personal account flags. Max 5x/20x stays in `subscription.rate_limit_tier`, separate from `plan_type=max`. |
| Account usage | `GET https://api.anthropic.com/api/oauth/usage`; five-hour and seven-day percentages keep upstream units, including values below 1%. |
| Model usage | `seven_day_*` and active `limits[]` rows with `kind=weekly_scoped` are display-only; a model-specific limit never blocks all models. |
| Extra usage | `monthly_limit` and `used_credits` are minor currency units, converted by 100 into the supplied currency (USD when absent). Null limits remain unknown; disabled extra usage and spend without a finite limit remain visible. |
| Independent credit pools | Rows with dollar amount fields preserve their own pool identity, dollar amounts and resets. These are separate from extra-usage cents. |
| Setup tokens | Explicit scopes without `user:profile` return `unsupported` / `missing_profile_scope` without calling account endpoints. Documents without scope metadata are still probed. |
| API keys | Subscription endpoints are not called for API-key-only accounts; subscription quota is unsupported, with no invented API balance. |
| Query throttling | Existing shared manual/background schedule, five-minute Claude observation cache, exponential failure backoff and upstream `Retry-After`. |

## Independent observations

The normalized quota snapshot adds optional `subscription` metadata with its own `status`, `source` and bounded `error_code`. Successful live profile results replace stale credential plan hints, including clearing a product that is no longer recognized. Profile failures retain credential hints on a successful usage probe and are visible in the management quota display.

A profile request has a three-second timeout inside the existing probe budget. Profile failure does not discard successful usage, refresh a token that just fetched usage successfully, disable inference, or create fake capacity. Conversely, when usage fails but profile succeeds, Relay updates the subscription metadata while retaining the previous usage windows, `observed_at` and `quota_observed_at`. Usage remains in the error state and continues to back off. An expired five-hour generation cannot be released by a profile-only success.

The snapshot retains only product metadata, normalized windows and query status. It excludes profile account/organization UUIDs, names, emails, tokens and raw profile error bodies. It does not infer subscription expiry or renewal from quota reset dates, or use observed dollar balances to grant local parent capacity.

## Verification and boundaries

Fixture tests cover plan upgrades, organization precedence, free/unknown plans, independent usage/profile failures, scope capability, percent/amount units, null/zero limits, model-scoped limits, independent dollar pools, snapshot privacy and retaining usage generations during metadata updates. Browser tests cover live/stale plan display, partial snapshots, missing permissions and extra-usage amounts. The existing CPA parity tests cover Messages and translated OpenAI requests, streaming and canonical usage.

No real subscription account is required by these tests. Live compatibility, upstream schema changes, TLS/WAF behavior and plan-specific availability still require verification with an authorized account. This change does not redeem reset credits, change spending limits, switch organizations or simulate paid inference to obtain quota. Model-specific observations do not currently create separate model admission budgets.

## References

The implementation was compared with [Sub2API account usage](https://github.com/Wei-Shaw/sub2api/blob/dba770d56a0ee0ae5bad1b3dc5e11614d323163c/backend/internal/service/account_usage_service.go) and its [Claude usage fetcher](https://github.com/Wei-Shaw/sub2api/blob/dba770d56a0ee0ae5bad1b3dc5e11614d323163c/backend/internal/repository/claude_usage_service.go), plus CPA Management Center's [Claude provider](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/features/quota/providers/claude/data.ts), [usage normalization](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/services/api/claudeUsage.ts) and [wire types](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/714de0760a3ce86094b178fb46f834d34bc4a2a5/src/types/quota.ts). Relay retains its existing PostgreSQL quota and settlement architecture.
