# Data retention

RelayAPI keeps short-lived request detail, medium-lived request summaries and
long-lived daily aggregates. Cleanup runs hourly with a PostgreSQL advisory
transaction lock, `SKIP LOCKED`, bounded batches and a maximum runtime.

| Data | Default retention |
| --- | --- |
| 成功、定价完整的完整请求详情 | 默认不抽样（`REQUEST_LOG_SUCCESS_SAMPLE_PPM=0`）；若提高抽样则保留 1 天 |
| 错误或定价不完整的完整请求详情 | 14 天 |
| 请求摘要 | 30 天，删除前汇总到 `usage_daily_rollups` |
| 上游待关联终态 | 新流量不再写入；孤儿记录 24 小时后清理 |
| 历史已处理上游生命周期事件 | 成功 24 小时，错误 7 天（兼容旧版本） |
| 已结算/释放/过期的请求预留 | 14 天；定价不完整记录 90 天 |
| 父额度原始观测 | 180 天 |
| 已使用、撤销或过期邀请 | 30 天 |
| 手工充值和计费账本 | 不自动删除 |

Request, forwarded-request and upstream-response captures are bounded and only
stored in the detail table. Setting a retention duration to zero disables that
cleanup class; it does not immediately delete data.
