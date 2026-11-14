# WS 与性能排查（2026-11-14）

## 线上证据

对 `root@hangzhou-aliyun` 仅执行了日志、指标和限时只读 SQL。未重启容器、改生产
配置、重放用户生成或发布补丁。运行版本为 `8c1bf11877d55e00a86aed2451c1dd8ef8c4cf2c`。

检查时近 22 小时有 147 条 `responses.websocket` 步骤：140 条明确报告
`websocket: protocol "h2" was given but is not supported; sharing tls.Config with net/http Transport can cause this error`，
6 条连接未建立、1 条终态前中断、0 条成功。后 7 条不能仅凭汇总认定为相同根因。
HTTP 101 只说明入口升级成功，不代表上游生成成功。

2,944 次准入全部在 5ms 桶内；数据库连接等待累计为零。采样时主机负载约 0.18，
应用 29 个 goroutine、约 53MiB 内存。这不是峰值容量测试，不支持盲目增加并发。

成功 HTTP 请求首 Token P50 为 9,781ms、P95 为 29,337ms。
最近 500 个成功 Responses 请求的单阶段数据如下，阶段不能简单相加：

| 阶段 | P50 ms | P95 ms |
| --- | ---: | ---: |
| Key 解析 | 1.698 | 3.621 |
| 模型解析 | 1.205 | 6.757 |
| 计费准入 | 6.809 | 15.805 |
| 运行时调度 | 6.228 | 48.667 |
| 向上游写请求 | 971.534 | 6,942.670 |
| 请求写完至上游首字节 | 1,164.510 | 2,961.476 |

大上下文上传、账户代理链路和上游生成等待应分开测量；首字节也不等于首 Token。
环境变量 `RELAY_UPSTREAM_WEBSOCKETS=false` 不能单独证明当前 WS 已关闭：数据库
热更新策略优先于环境初始值，验收需检查实际策略与新建客户端会话。

## 根因和修复

原实现直接借用 `http.Transport.TLSClientConfig`。net/http 为普通 HTTPS 配置 h2
ALPN 后，Gorilla 仍发送 HTTP/1.1 Upgrade，结果收到 HTTP/2 二进制帧。

修复为克隆账户 TLS 配置，只对 WS 设置 `NextProtos = ["http/1.1"]`。
保留账户代理、拨号器、证书信任和普通 HTTPS 的 HTTP/2；不通过自动重试或忽略 1006
掩盖错误。`TestProviderWebSocketIsolatesHTTP2ALPN` 使用真实本地 TLS/HTTP2 服务，
先发 HTTP/2 请求再连 WSS：旧代码复现线上错误，新代码通过且共享 Transport 未改变。

性能上，逐 Token/WS 类型及模型提取避免全树解码；metadata 不再展开完整输出以寻找
不存在的 delta。Codex 请求适配和模型改写只修改必要字段，已规范化请求不重建
input/tools，并保留扩展字段原始 JSON，避免大整数经 float64 舍入。调用方原始缓冲不变。

Windows amd64、Go 1.27.3、Ryzen 7 7840H，`-benchmem -count=2`：

| 微基准 | 修改前 | 修改后 |
| --- | --- | --- |
| Responses delta 识别 | 约 1,300ns / 504B / 15 allocs | 约 205ns / 40B / 2 allocs |
| 非终态 WS 类型识别 | 约 1,290ns / 504B / 15 allocs | 约 59ns / 32B / 1 alloc |
| 已规范化约 286KiB 请求适配 | 约 1.72ms / 1.63MB / 10,301 allocs | 约 0.53ms / 295KB / 1 alloc |
| 同大小、需要改写的请求 | 约 1.65ms / 1.68MB / 10,303 allocs | 约 0.94ms / 1.18MB / 9 allocs |

微基准不是线上吞吐或首 Token 的同比承诺。未设置 `TEST_DATABASE_URL` 时数据库集成
测试会跳过，不能把普通测试通过等同于真实数据库、真实订阅账户验收。

## 发布后验收（尚未执行）

使用经过 CI 的不可变镜像并保留回滚版本。以专用测试用户/账户验证 HTTPS 后 WSS、
真实 `generate:false`、同连接工具续接、同账户 OAuth 刷新及账户代理路径；不重放用户
请求。检查成功终态、幂等账务和额度归属，而不是仅看 101/1000。比较同模型、同账户、
相近上下文的首 Token 和错误率；失败时回滚，不自动重复提交生成。

## 网上方案及采用边界

- [OpenAI WebSocket 模式](https://developers.openai.com/api/docs/guides/websocket-mode)：
  持久连接、增量 input、previous_response_id；预热准备真实服务端状态，不能伪造响应
  ID。断线会丢连接内缓存，store=false 恢复需要完整上下文。公开 API 文档不自动证明
  ChatGPT Codex 后端的所有能力。
- [Gorilla 握手源码 v1.5.3](https://github.com/gorilla/websocket/blob/v1.5.3/client.go)：
  明确诊断共享 TLS 配置中的 h2，直接对应线上错误。
- [Gorilla 并发契约](https://pkg.go.dev/github.com/gorilla/websocket#hdr-Concurrency)：
  一个数据 reader、一个数据 writer，控制帧和关闭另有并发保证。
- [RFC 8441](https://www.rfc-editor.org/rfc/rfc8441)：HTTP/2 WS 需要 Extended CONNECT，
  不能协商 h2 后继续发 HTTP/1.1 Upgrade。
- [Sub2API WS 池](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_ws_pool.go)：
  阅读作生命周期对照，不直接移植。跨用户池化前需证明服务端状态、账户亲和和计费隔离，
  不能因为“池化更快”就引入本系统。
