# Data retention

RelayAPI keeps short-lived request detail, medium-lived request summaries and
long-lived daily aggregates. Cleanup runs hourly with a PostgreSQL advisory
transaction lock, `SKIP LOCKED`, bounded batches and a maximum runtime.

| Data | Default retention |
| --- | --- |
| 成功、定价完整的完整请求详情 | 默认不抽样（`REQUEST_LOG_SUCCESS_SAMPLE_PPM=0`）；若提高抽样则保留 1 天 |
| 错误或定价不完整的完整请求详情 | 14 天 |
| 请求摘要 | 30 天，删除前汇总到 `usage_rollups_v2` |
| 上游待关联终态 | 新流量不再写入；孤儿记录 24 小时后清理 |
| 历史已处理上游生命周期事件 | 成功 24 小时，错误 7 天（兼容旧版本） |
| 已结算/释放/过期的请求预留 | 14 天；定价不完整记录 90 天 |
| 父额度原始观测 | 180 天 |
| 已使用、撤销或过期邀请 | 30 天 |
| 原生压缩摘要路由 | 最后使用后 90 天；仅保留租户、密文摘要和上游账户 ID |
| 手工充值和计费账本 | 不自动删除 |

Request, forwarded-request and upstream-response captures are bounded and only
stored in the detail table. Setting a retention duration to zero disables that
cleanup class; it does not immediately delete data.

请求归档现在按 UTC 分钟、租户、模型与 API Key 聚合，支持读取时按 IANA 时区重新分日。
零费用和未定价生成记录也参与归档；缓存未知、1 小时缓存写入、取消及解码样本随归档保存。
旧日归档缺失的 Key 与分钟信息不推断，迁移不会重算历史扣费。
