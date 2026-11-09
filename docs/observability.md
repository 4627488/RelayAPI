# 可观测性：Loki 日志与 Prometheus 指标

## 后台日志与扣费明细

页面中的「扣费明细」保留请求用量、价格、扣费来源和诊断详情，账务依据仍是 PostgreSQL。后台运行日志使用 Go slog 输出单行 JSON，内嵌 CPA 的 logrus 也使用相同格式和脱敏规则。`RELAY_LOG_LEVEL=info` 为默认值，可设为 `debug`、`warn` 或 `error`，修改后需要重启服务。

Loki 接收**推送**，不会像 Prometheus 一样定期抓取应用的 `/metrics`。本项目的数据流是：RelayAPI stdout → Docker 日志 → Grafana Alloy 采集 → HTTP 推送 Loki → Grafana 查询。应用无需知道 Loki 的地址，Loki 暂时不可用时不会让生成请求等待网络投递。

指标保持 Prometheus 拉取，Grafana 同时查询 Prometheus 与 Loki。长期运行服务使用拉取便于统一控制采集频率，并通过 `up` 判断采集目标是否可达。跨站点且只能主动出网时，可在站点内由 Alloy 抓取 `/metrics` 后用 `remote_write` 推送中心；不需要让应用自己定时发送指标。

| 级别 | 记录内容 |
| --- | --- |
| INFO | HTTP 完成摘要、生成用量摘要、结算结果、启动关闭和重要生命周期事件 |
| WARN | 4xx、准入拒绝、用量或计价不完整、上游尝试失败、可恢复的凭据刷新故障 |
| ERROR | 5xx、panic、数据库持久化/结算失败、后台任务失败 |
| DEBUG | 成功健康检查/指标抓取、静态页面访问、预热、成功后台任务和上游尝试 |

HTTP 摘要覆盖鉴权失败、管理接口操作、普通生成、SSE 和 WebSocket；WebSocket 在连接结束时记录 HTTP 摘要，生成用量按每个已持久化轮次记录。`X-Relay-Request-ID` 由服务生成并返回，可用它关联 HTTP、生成摘要和结算；WebSocket 轮次的 `session_request_id` 指向连接请求。`inference.completed` 的费用为评估费用，是否持久化成功应查看随后 `billing.settled` 的 `success` 字段，最终以扣费明细为准。

日志不主动采集请求正文、响应正文、请求头、Cookie、完整 URL 或查询参数。常见凭据字段、Bearer、sk- Key 及 URL 用户信息/查询参数会脱敏，单个文本字段限制为 4 KiB。自由文本脱敏不能识别任意格式的秘密，因此禁止新增包含完整请求或凭据对象的日志。请求诊断正文仍按原有 PostgreSQL 权限和保留策略管理。

### 启动 Loki 与 Alloy

在已配置 `.env` 的部署目录运行：

```sh
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

示例固定使用 Loki 3.5.7 和 Alloy 1.11.3，Loki 本地文件存储默认保留 14 天；生产规模增大时应根据容量改用对象存储。Docker 应用日志轮转为 20 MiB × 5 个文件。Alloy 的读取位置及发送 WAL 使用持久化卷，网络失败由采集器重试；超出重试/保留窗口、轮转、磁盘满或进程崩溃仍可能丢失日志，不作为审计账本。监控磁盘余量和 Alloy 投递失败。

Alloy 只采集同一个 Compose 项目中的 `relayapi` 服务。它挂载 Docker socket 以读取日志；即使挂载为只读，Docker API 权限仍很高，仅向可信的采集器开放。示例 Loki 无鉴权，仅绑定宿主机 `127.0.0.1:3100`，不得直接暴露公网。

在 Grafana 添加 Loki 数据源：Grafana 若加入相同 Docker 网络，地址为 `http://loki:3100`；宿主机 Grafana 使用 `http://127.0.0.1:3100`。远程 Grafana 需要自行配置内网连通与鉴权代理，不能使用其自身的 localhost。已有 Loki 时可修改 `config.alloy` 的 `loki.write.local.endpoint` 地址及对应鉴权配置，并省略本地 Loki 服务。

只把服务、Compose 项目、级别等有限值作为 Loki 标签；请求 ID、用户、Key ID、模型等留在 JSON 字段中查询，避免标签基数膨胀：

```logql
{service_name="relayapi", level="ERROR"} | json
{service_name="relayapi"} | json | request_id="替换为响应头中的请求ID"
{service_name="relayapi"} | json | session_request_id="替换为连接请求ID"
{service_name="relayapi"} | json | event="billing.settled" | success="false"
{service_name="relayapi"} | json | event="http.completed" | status >= 500
```

## Prometheus 指标

统一入口 `GET /metrics` 暴露 Relay、同进程 CPA、Go 和进程指标，支持 Prometheus 文本格式和 OpenMetrics 内容协商。使用独立的应用 registry，多个 App 实例不会共享业务计数。抓取不查询上游、不扫描请求日志、不请求数据库；数据库指标来自 `database/sql` 本地连接池快照。指标请求本身不计入 HTTP 请求指标，同时最多允许两个并发抓取，超过时返回 503。

默认无需登录。公开部署可设置独立的 `RELAY_METRICS_TOKEN`，抓取端通过 `Authorization: Bearer <token>` 访问。该配置需要重启；它不是租户 API Key。配置后缺失或错误的凭据返回 401。也可以通过反向代理或内网控制访问。

```sh
curl -fsS http://localhost:8080/metrics
# 设置 token 后：
curl -fsS -H "Authorization: Bearer $RELAY_METRICS_TOKEN" http://localhost:8080/metrics
```

抓取配置见 [observability/prometheus.yml](observability/prometheus.yml)，告警规则见 [observability/alerts.yml](observability/alerts.yml)。示例使用 Compose 网络里的 `relayapi:3000`；宿主机部署需改为实际地址，例如 `localhost:8080`。Prometheus 需要加入 Relay 的 Docker 网络。使用鉴权时在抓取配置启用 `authorization.credentials_file`，文件内容为 token 本身。

## HTTP 与生成请求

| 指标 | 类型 / 标签 | 含义 |
| --- | --- | --- |
| `relay_http_requests_total` | Counter：method、route、status | 所有 HTTP 请求，WebSocket 握手成功计为 101，连接结束时累计 |
| `relay_http_request_duration_seconds` | Histogram：method、route | 整个 handler 时长；WebSocket 是连接存活时间 |
| `relay_http_in_flight` | Gauge：transport | 活跃 HTTP handler / WebSocket 连接 |
| `relay_inference_requests_total` | Counter：protocol、transport、status、pricing、settled | 生成请求结果，WebSocket 按持久化的每轮计数 |
| `relay_inference_duration_seconds` | Histogram：protocol、transport | 生成请求或一轮的耗时，不含之后的结算处理 |
| `relay_inference_first_byte_seconds` | Histogram：protocol、transport | 首个上游响应字节/事件的延迟，有观测才记录 |
| `relay_inference_first_token_seconds` | Histogram：protocol、transport | 首个生成内容延迟，心跳、角色和用量事件不算 token |
| `relay_inference_body_bytes` | Histogram：direction、transport | request / forwarded / response 的负载大小 |
| `relay_inference_tokens_total` | Counter：protocol、transport、kind | input、output、cached、cache_write、reasoning、total 及 image_input、cached_image_input、image_output |
| `relay_inference_usage_quality_total` | Counter：transport、quality | complete / incomplete / inconsistent / unclassified / missing / unknown 用量质量 |
| `relay_prewarm_requests_total` | Counter：transport | 非生成预热，不计入生成次数、Token、费用和延迟 |
| `relay_billing_cost_usd_total` | Counter：transport | 已结算的已知费用，nano-USD 换算为 USD |
| `relay_persistence_operations_total` | Counter：operation、outcome | 日志写入、HTTP/WS 结算、预占释放、WS 用量事务和凭据刷新持久化的成功/失败 |

`protocol` 是 Responses、Chat Completions 等有限协议分类；`transport` 是 http / sse / websocket。`pricing` 为 complete / incomplete。匿名鉴权失败在 HTTP 指标中可见，不会创建生成用量记录。

HTTP 生成结果在结算流程写日志时记录，即使日志写入失败仍有结果指标。WebSocket 成功终态只在用量事务首次插入后记录；重复终态和连接汇总不重复计数，中断的已接收轮次另计。没有生成请求的连接不计生成次数。事务失败通过 persistence 指标暴露，未持久化的终态不伪装成已经结算的用量。

Token 桶存在包含关系：cached 通常属于 input，reasoning 通常属于 output，图片也可能属于总量；**不要把所有 kind 求和**。总消费使用 `kind="total"`。用量缺失不会被解释为免费生成，需同时看 quality 和 pricing。费用计数仅为进程内运营统计，账务以 PostgreSQL 为准。

## 准入、数据库与后台任务

| 指标 | 含义 |
| --- | --- |
| `relay_admission_requests_total{outcome}` | accepted / overloaded / circuit_open / canceled；跨运行策略热更新持续累计 |
| `relay_admission_wait_seconds{outcome}` | 获取并发槽位和请求体内存预算的耗时 |
| `relay_admission_in_flight` / `relay_admission_capacity` | 当前控制器的占用与并发上限 |
| `relay_admission_queue_depth` / `relay_admission_queue_capacity` | 等待并发槽位的请求数与队列上限；不含拿到槽位后等待内存的请求 |
| `relay_admission_request_bytes` / `relay_admission_request_capacity_bytes` | 预留的请求内存和上限，不是实际堆内存 |
| `relay_admission_rejected_since_reload` | 当前控制器拒绝数，Gauge，策略热更新会重置；告警速率使用 requests_total |
| `relay_admission_consecutive_failures` | 全局熔断连续失败数，关闭全局熔断时为 0 |
| `relay_admission_circuit_state` | closed=0、half_open=1、open=2 |
| `relay_admission_retry_after_seconds` | 熔断剩余冷却时间 |
| `relay_finalization_in_flight` / `relay_finalization_capacity` | 异步结算任务占用和上限，不含饱和时同步执行的任务 |
| `relay_db_connections{state}` | open / in_use / idle 连接池快照，不代表数据库可用性 |
| `relay_db_max_connections` | 最大连接数，0 表示不限 |
| `relay_db_wait_total` / `relay_db_wait_duration_seconds_total` | 等待数据库连接的次数、累计秒数 |
| `relay_db_closed_connections_total{reason}` | idle_limit / idle_time / lifetime 导致的连接关闭数 |
| `relay_background_jobs_total{task,outcome}` | pricing_catalog / quota_sync / retention 执行结果 |
| `relay_background_job_duration_seconds{task}` | 后台任务执行耗时 |
| `relay_background_job_last_success_timestamp_seconds{task}` | 最近成功完成的 Unix 时间；启动后未成功的任务没有样本 |

目录刷新包含手工触发；额度同步指标记录整个自动同步周期，任一账户失败则周期失败。没有需要探测的账户也可成功完成。连接池采样不执行 Ping；服务健康检查仍用 `/healthz`。

## 内嵌 CPA

当前固定的 CPA 版本没有可直接合并的原生 Prometheus exporter。Relay 通过已有 executor 包装和 CPA scheduler 状态读取统一导出，没有启用外部 CPA 服务或公开管理接口。

| 指标 | 类型 / 标签 | 含义 |
| --- | --- | --- |
| `relay_cpa_up` | Gauge | Runtime 已安装且 loopback listener 没有记录服务错误；不代表上游健康 |
| `relay_cpa_execution_attempts_total` | Counter：provider、kind、outcome | 每次实际执行，含失败重试、轮换和 count；success / failure / canceled |
| `relay_cpa_execution_duration_seconds` | Histogram：provider、kind | 每次 executor 执行耗时，流式请求直到输出结束 |
| `relay_cpa_execution_stage_seconds` | Histogram：provider、stage | connection_wait / dns / connect / tls / upstream_first_byte / headers / first_chunk |
| `relay_cpa_credentials` | Gauge：provider、condition | enabled / disabled / unavailable / quota_exceeded / cooling 的凭据数 |

kind 为 request / stream / count；CPA 执行次数通常高于生成请求数，不能作为客户请求总数。CPA 无 request ID 的执行也能统计。传输时序仅在真实观测到首尾时间时记录；连接复用、WebSocket 或传输重放可能没有 DNS/TLS 等样本，缺失不填 0。first_chunk 不是首个生成 token，请使用 Relay 的 first_token 指标衡量生成延迟。

凭据 condition 可重叠，例如 enabled 同时 unavailable。provider 归一化为内置有限类别，兼容服务自定义名称合并到 other。CPA 原生用量仍经现有 SDK 插件进入 Relay 结算，统一 Token 指标不会再次累计 CPA 的相同用量。

## 查询与边界

```promql
# 请求速率 / 5xx 比例
sum(rate(relay_inference_requests_total[5m]))
sum(rate(relay_inference_requests_total{status=~"5.."}[5m]))
  / clamp_min(sum(rate(relay_inference_requests_total[5m])), 0.001)

# 各协议、传输方式首 token P95
histogram_quantile(0.95,
  sum by (le, protocol, transport) (rate(relay_inference_first_token_seconds_bucket[5m])))

# Token 每秒速率与每小时已知费用
sum by (transport) (rate(relay_inference_tokens_total{kind="total"}[5m]))
sum(increase(relay_billing_cost_usd_total[1h]))

# CPA 按 provider 的失败速率
sum by (provider) (rate(relay_cpa_execution_attempts_total{outcome="failure"}[5m]))

# 数据库平均等待时长
rate(relay_db_wait_duration_seconds_total[5m])
  / clamp_min(rate(relay_db_wait_total[5m]), 0.001)
```

Histogram 使用秒和字节；时间桶覆盖 5ms 到 24h，适合长时间 SSE 请求。业务 Counter 在进程重启后清零，Prometheus 的 rate/increase 可处理重置。业务标签没有租户、Key、凭据 ID、模型名、完整 URL、请求 ID 或上游错误正文；route 使用 ServeMux 模板，未知路径归并 unmatched。分模型/租户明细仍查看请求日志和用量报表，避免动态输入制造无界时序。指标命名遵循 [Prometheus 官方约定](https://prometheus.io/docs/practices/naming/)。

Go 指标由标准 collector 提供，包括 `go_goroutines`、`go_memstats_*`、`go_gc_duration_seconds` 等；`process_*` 随操作系统支持提供，Windows 不保证具备 Linux 的全部进程指标。没有 CPU/RSS 样本时请使用主机或容器 exporter。
