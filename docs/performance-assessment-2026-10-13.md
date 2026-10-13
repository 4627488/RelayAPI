# 杭州服务器性能评估

评估时间：2026-10-13 17:16–17:23（Asia/Shanghai）。目标：`root@hangzhou-aliyun`。
只读采样；未修改生产配置、未重启服务、未发送收费推理请求。

## 结论

当前没有 CPU 或连接池饱和。优先优化报表查询，其次对额度探测的 429 做退避，并收紧小内存主机的资源预算。推理首 token 延迟包含上游生成和网络耗时，不能依据总请求耗时认定本机处理慢。

## 证据

| 项目 | 实测 |
| --- | --- |
| 主机 | 2 vCPU，1613 MiB RAM，2047 MiB swap |
| 负载 | load average 0.13/0.29/0.33；短时 CPU idle 85–95% |
| 内存 | available 740 MiB；swap 已使用约 488 MiB；短时有少量换入换出 |
| 磁盘 | 根分区 73%，剩余约 11 GiB；短时 iowait 0–1% |
| 应用 | 镜像 sha-0a0b972，启动于 11:09；无 OOM、无容器重启 |
| 本机健康接口 | HTTP 200，约 4.2 ms |
| 应用 RSS | 指标采样约 297 MiB；容器采样约 358 MiB |
| GC | 最近摘要最大暂停约 0.89 ms |
| 准入 | 容量 1024，在途 27，队列 0；3990 次接受全部在 5 ms 桶内 |
| 请求内存预算 | 上限 8 GiB；当时预留约 29 MiB |
| 数据库连接池 | open 4，idle 4，wait count/time 均为 0，max 32 |
| 管理端用量接口 | 12 次累计 18.86 s，平均 1.57 s |
| 管理端日志接口 | 55 次累计 18.50 s，平均 336 ms |
| 用户用量接口 | 18 次累计 3.70 s，平均 205 ms |
| 额度同步 | 738 周期中失败 534，约 72.4%；周期均值约 4.35 s |
| 额度近期错误 | 最近 30 分钟 31 次 Claude quota HTTP 429 |
| 数据库大小 | 930 MB；request_logs 含索引 631 MB，约 13 万行 |

HTTP 均值及业务计数是应用本次启动以来的累计值，不是最近窗口的 P95。数据库统计的累计周期与应用计数不同。短时资源采样不能排除高峰问题；已有 swap 不等于当前持续内存耗尽。

## 查询验证

在只读事务中、5 秒 statement_timeout 下执行代表性查询：

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT count(*), sum(total_tokens), sum(cost_nano_usd)
FROM request_logs
WHERE log_unit NOT IN ('prewarm','connection')
  AND started_at >= CURRENT_DATE - INTERVAL '29 days';
```

耗时 212.624 ms，Parallel Seq Scan，匹配约 123942 行。shared hit=7282、read=23767，共访问约 243 MiB 数据页；read 表示读入 PostgreSQL shared buffers，并不必然是物理磁盘读取。
本地 `internal/store/store.go` 的 UsageReport 分别执行汇总、每日和其他分组；`usage_observability.go` 还计算分位数。因此扫描是明确的优化方向，完整线上 SQL 仍需逐条验证。

## 优化顺序

1. **报表查询**：合并能共用扫描的聚合，为同条件报表增加短期缓存并避免并发重复计算；检查现有 daily rollup 如何扩展到近期数据，保证原始日志与汇总不重复计费。分位数不应每次随多个图表重复计算。用相同数据、相同时间范围验证接口耗时和结果一致性。
2. **额度探测**：Claude 429 按凭据做退避，优先采用响应中的 Retry-After；成功后恢复正常周期，保留手动同步与已有额度数据。当前每 30 秒默认周期及无失败退避的路径值得修改，避免持续撞限流。
3. **内存预算**：生产 GOMEMLIMIT=1100MiB、GOGC=50；应用容器上限 1400MiB，数据库上限 768MiB，而整机仅 1613MiB，另有 uptime-kuma 和其他服务。1024 并发及 8GiB 请求预算缺乏对应物理内存支持。先按真实请求大小和峰值测定预算，再调整；不能直接降低到会拒绝当前流量的值，也不能把更高并发当作延迟修复。
4. **数据库索引**：存在完全重复的 upstream_request_id、upstream_trace_id、upstream_execution_id 索引对，其中 request_id 两份各约 22MB。可在确认依赖和迁移创建逻辑后删除重复项，降低写入和存储开销。单纯 idx_scan=0 不足以删除其余索引。

推理延迟：Chat SSE 平均首 token 7.37 s，Responses SSE 12.90 s，Responses WebSocket 9.06 s，样本和模型构成不同，不能直接用来比较协议优劣。CPA Codex first_chunk 均值约 3.83 s、xAI 约 8.41 s；xAI connection_wait 有观测的 691 次均值约 0.97 s。需进一步按时段采样和核对账户代理/连接复用来归因，尚未证明具体网络瓶颈。

数据库未启用 pg_stat_statements、track_io_timing；尚无完整慢 SQL 排名。后续变更应记录基线、复测同一查询，并观察高峰内存和错误率。

## 已实施的优化与复测

2026-10-13 在线创建 `request_logs_usage_cover_idx`，删除三份已验证完全重复的旧 CPA 命名索引，并执行普通 VACUUM ANALYZE。代表性汇总由 212.6 ms 降至 67.7–106.9 ms；数据页访问由约 243 MiB 减至约 28 MiB。配合一并提交的今日 Token 速率图，增加约 3.8 MiB 的 `request_logs_token_rate_idx`。

使用生产数据的同一 REPEATABLE READ、READ ONLY 快照，交替关闭/开启 Index Only Scan 进行完整调用对比，结果如下。这是短时查询实验，不是接口高峰 P95。

| 调用 | 关闭 Index Only Scan | 开启 Index Only Scan |
| --- | --- | --- |
| 全站 30 天 UsageReport，第 1 轮 | 1619 ms | 1178 ms |
| 全站 30 天 UsageReport，第 2 轮 | 1577 ms | 897 ms |
| 今日 Token 速率，第 1 轮 | 36 ms | 14 ms |
| 今日 Token 速率，第 2 轮 | 19 ms | 10 ms |

两轮报表 summary 的 SHA-256 相同，Token 速率完整结果的 SHA-256 相同。两个索引共约 32 MiB，移除重复项约 40 MiB，净减少约 8 MiB。结构备份及测试日志保存在服务器 `/opt/relayapi/performance-20261013/`，在线执行和回滚脚本在 `deploy/`。

额度探测现在按凭据串行，429 采用 1/2/4/8/15 分钟退避并尊重更长的 Retry-After；成功清除退避，等待期间不覆盖已有额度观测。重启会清除进程内退避；它不影响推理准入。

Linux 验证发现并修复原生 WebSocket 在前一轮完成后的 EOF 与下一轮完整请求之间的竞态：收到下一轮响应前发生 EOF，可重连并重发一次独立完整请求；带 previous_response_id 的增量请求不自动重放，已收到新响应后也不重放。每轮重置终态判断，避免中途断开被误认为上一轮的正常结束。Linux 重连测试重复 30 次通过。

验证：Go 全套测试与 vet、CPA bridge 测试与 vet、前端格式/类型/lint/93 个浏览器测试/构建通过；数据库和存储集成测试在隔离 PostgreSQL 库通过。Linux 应用和上游测试通过，其中应用套件跳过了一个需要 GNU base64 的 OpenCode 安装脚本测试（测试执行容器为 Alpine）；该包在 Windows 上完整测试通过。临时测试库已删除。应用变更通过统一提交推送后由既有 CI/CD 构建和部署。
