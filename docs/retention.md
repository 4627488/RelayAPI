# 数据留存与自动清理

RelayAPI 使用三级数据生命周期：短期请求内容、中期请求摘要和长期每日聚合。
自动清理每小时执行，使用 PostgreSQL advisory transaction lock、`SKIP LOCKED`
和有界批次，避免多个实例重复工作或单次删除制造长事务。

默认策略：

| 数据 | 留存 |
| --- | --- |
| 成功、定价完整的完整请求详情 | 默认不抽样（`REQUEST_LOG_SUCCESS_SAMPLE_PPM=0`）；若提高抽样则保留 1 天 |
| 错误或定价不完整的完整请求详情 | 14 天 |
| 请求摘要 | 30 天，删除前汇总到 `usage_daily_rollups` |
| CPA 待关联终态 | 新流量不再写入；孤儿记录 24 小时后清理 |
| 历史已处理 CPA 生命周期事件 | 成功 24 小时，错误 7 天（兼容旧版本） |
| 已结算/释放/过期的请求预留 | 14 天；定价不完整记录 90 天 |
| 父额度原始观测 | 180 天 |
| 已使用、撤销或过期邀请 | 30 天 |
| 手工充值和计费账本 | 不自动删除 |

请求、转发请求和上游响应每段最多持久化 128 KiB，并只保存在请求详情中。Bridge
0.6+ 是纯控制面插件，不再产生新的 CPA 生命周期或终态关联记录；相关表和清理策略
仅用于兼容升级前已有的数据。活动请求预留以及计费账本不会被留存任务删除。

删除采用 `RETENTION_BATCH_SIZE` 控制批次，并由
`RETENTION_MAX_RUNTIME_SECONDS` 限制每轮运行时间。设置某项留存天数为 `0` 会
禁用该类清理，而不是立即删除全部数据。

PostgreSQL 的普通 `DELETE` 和 autovacuum 会让空间可以复用，但不会保证操作系统
看到的数据文件立即缩小。日常运行不应自动执行会锁表的 `VACUUM FULL`；需要首次
回收历史膨胀时，应在维护窗口使用 `pg_repack`，或确认可接受锁表后手工执行
`VACUUM FULL`。

检查主要空间占用：

```sql
SELECT relname,
       n_live_tup,
       n_dead_tup,
       pg_size_pretty(pg_relation_size(relid)) AS table_size,
       pg_size_pretty(pg_indexes_size(relid)) AS index_size,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```
