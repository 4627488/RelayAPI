# rai 与 Codex 当前互操作架构

2026-10-22 更新。本文描述已实现的职责与约束；源码对照、过时字段和后续改进见 [rai 与 Codex 源码互操作分析](rai-codex-interoperability.md)。认证和管理命令见 [rai 使用文档](rai-cli.md)。

## 职责

rai 管理站点 profile、浏览器 PKCE 设备授权、凭据存储与续期，配置或启动真实客户端。Codex 管理会话、本地工具、模型选择和用户安全策略。RelayAPI 管理模型授权、目录投影、协议适配、准入和计费；PostgreSQL 是配额与结算的事实来源。

模型调用和账户管理分别使用 `inference`、`account` OAuth purpose，具有独立凭据与当前 profile。普通用户自助管理已实现；“不提供管理 CLI 或独立管理授权”属于被替代的历史设计。账户管理凭据不注入 Codex，模型凭据不能管理 Key，也不因用户具有管理员身份而获得全站管理能力。

## Codex 接入与恢复

`rai codex` 使用单次运行 provider 和命令行配置；`rai configure codex` 合并用户配置，绑定 rai 凭据助手。助手绑定 rai 目录、profile 与服务器，只输出 access token 或明确导入的静态 Key；不输出 refresh token。助手每分钟检查、超时三十秒；子进程不额外携带 rai bearer 环境变量。

`CODEX_HOME` 被用于寻找用户配置。`configure/unconfigure codex --codex-profile <name>` 管理原生 `<name>.config.toml`，不改根文件，共享历史。带原生 profile 启动时跳过根配置 mtime 偏好导入；`sync codex --codex-profile <name>` 显式同步所选文件。未选原生 profile 时保留原有根配置导入，以兼容已有流程。真实 CLI 已验证；`app-server --profile` 不受客户端支持，Desktop 的原生 profile 选择仍需独立验收。

持久配置保存备份与恢复 journal，三方恢复保留用户后续编辑。`rai codex --desktop` 使用明确的应用退出、切换、恢复流程；CLI 进程结束不代表 Desktop singleton 已退出。Desktop 原生 profile 替代方案经验证前保留这些恢复路径。不修改 Codex 会话数据库或伪造 ChatGPT 登录，不改变 Codex 的审批与 sandbox 策略。

## 模型目录

模型 ID 按运行时发布的原值返回和调用，不自动补充模型作者前缀。网页、日志、报表及 rai 均显示原 ID；已有完整 ID 与显式配置的 Key 别名保持原义。模型能力资料仅补充能力字段，不用于改名。

`internal/upstream/codex_catalog.go` 从运行时 slug 构造完整 Codex ModelInfo；`internal/app/native_models.go` 应用模型能力、管理员覆盖、授权和别名。models.dev 第一方资料覆盖上下文、输入/输出预算、推理和模态，OpenAI slug 只接受第一方 OpenAI 资料，聚合商不能覆盖同名官方模型；模型资料不授予访问权限。管理员明确的能力值应被保留，传输能力受实际运行时约束。

目录流程包括：生成完整条目、应用能力/覆盖、用户可见性与别名过滤、内容 revision 和 ETag。隐藏条目仍需满足客户端反序列化契约。保留隐藏 tombstone 是为了防止客户端内置目录按 slug 合并后重新显示受限模型；真正的调用权限仍由服务端强制执行。图像生成专用模型不进入对话选择器，图像 API 保持可用。

现有模型目录仍输出 `prefer_websockets`、`supports_parallel_tool_calls`、`max_output_tokens` 等兼容字段。Codex 0.163.0 的 ModelInfo 已不读取这三项，不能再用它们证明客户端传输、工具或输出限制已生效；旧客户端、其他消费者和服务端模型事实的保留需求需分别处理。新客户端 WebSocket 选择由 provider 的 `supports_websockets` 与会话 fallback 决定；session 的 `codex.version=1` 契约声明当前 Key 全部可选模型的 transport、compaction v2 与 standalone search 能力，rai 按契约生成配置；旧版/未知契约保守使用 HTTP。静态 Key 的持久配置使用登录缓存的能力，网关策略变化后需要重新登录/配置。

完整 models.dev 能力快照与价格在同一 PostgreSQL 事务中保存，未定价模型仍保留资料；定价记录的原始 JSON 不丢弃未知字段。输入预算决定有效上下文百分比与压缩阈值，明确无工具能力的模型从 agent 选择器隐藏。支持 priority 的模式可投影 Fast；任意 experimental body patch 不执行。短 base instructions 和资料缺失时的通用缺省值仍保留，不宣称等同官方逐模型提示。服务端负责模型事实，rai 不维护另一份完整能力数据库。

## 协议适配与远程压缩

嵌入式 CPA 将 Responses WebSocket 每轮请求交给执行器，兼容执行器可转换到 Chat-only 上游。`openai` 凭据规范化到 CPA 的 `openai-compatibility` 路由，避免自定义模型被保留路由名称误拒绝。管理员的明确 WS 关闭覆盖 provider 声明。

兼容执行器使用既有 CPA summary/capsule codec 处理 compaction v2 的 `compaction_trigger`，经正常 Chat/Responses 执行器生成摘要，返回客户端接受的压缩项；续接时展开胶囊。SSE/WS 共用结果，usage 由真实摘要请求产生并关联终态 response ID，沿用正常准入和结算。它是摘要适配，不保证保留 OpenAI 原生私有推理状态。没有新增本机代理或数据库。服务端只为具备处理路径的 provider 集合启用 v2，真实商业上游仍需各自验收。

## 用户额度

额度投影复用已有子订阅分配、父窗口代次、预占与结算，不另建账本。金额使用整数 nano-USD，窗口使用量包含 settled + reserved，剩余量不得小于零。按用户、Key、模型权限和有效订阅过滤；普通账户余额不伪装成周期额度。

`GET /api/rai/quota` 与 `rai quota` 展示当前模型凭据可访问的订阅窗口。四次批量读取避免 N+1；未使用窗口按当前父窗口代次投影，不创建预占。

Codex 推理通路只投影本次 admission 选中的子订阅，以固定 `codex` bucket 整体替换旧状态，至多两个窗口，按有效周期从短到长选择。额外窗口仍留在内部与 rai 查询结果中。读取预算 250ms；无选定订阅、无有效窗口或读取失败时产生空状态，不能残留别的订阅额度。上游账号总额度不能替代用户获配额度。

HTTP 以 `x-codex-primary/secondary-*` 响应头提供响应前快照；WebSocket 使用 `codex.rate_limits`，并在每轮持久化终态用量后更新。缺失窗口为 null，切换订阅清除旧槽位。不向 SSE 插入它不消费的 WS 额度事件，上游私有额度事件也不透传。

`account/rateLimits/read` 与 `account/rateLimits/updated` 是 Codex app-server 协议，不是让第三方网关任意写额度的接口。历史客户端对多 bucket 的合并行为是当前单 bucket 策略的依据；新版源码具有多快照结构不代表多订阅输出已经端到端验收。

## 认证与长连接

浏览器登录签发短期 access token 与轮换 refresh token。refresh token 通过系统 keyring 或受限权限文件保存；跨进程锁串行刷新。退出 OAuth profile 先撤销服务端会话，再删除本地凭据；撤销失败保留凭据供重试。静态 Key 仍可通过 stdin 明确导入，退出只删除本地副本。

Relay 在每个新的 OAuth `response.create` 上重新验证授权，已接纳的流可完成，后续请求不能绕过到期或撤销。Codex 0.163.0 会将认证 revision 纳入连接复用判断；同一真实客户端进程的 HTTP 401 后 helper 刷新、轮换凭据保存与重试已验证；WS 到期关闭后的客户端恢复和慢网络仍需单独验收。

## 兼容验证

本次用原生 Codex 0.163.0 重新运行并通过：

```sh
CODEX_INTEROP_BINARY=/usr/lib/openai-codex/bin/codex \
  go test ./internal/rai ./internal/app \
  -run '^TestCodexClient' \
  -count=1 -v
```

测试使用隔离 CODEX_HOME、本地 mock 和假凭据，验证 helper 拉目录、原生 CLI profile、同进程 HTTP 401 续期、HTTP/WS 额度及自定义上下文采用。桥接模块用相同环境变量执行 `go test -run '^TestCodexClient' -count=1 ./...`，验证真实 Codex HTTP/WS 压缩与续接。CI 固定安装 0.163.0 并运行两组测试，未设置变量的普通测试仍会跳过。

0.158.0 曾出现自定义 provider 的 `/status` 显示回归，参见 [历史问题 #45052](https://github.com/openai/codex/issues/45052)。0.163.0 源码已将收到的额度快照传入状态卡片，不能继续把旧回归写成所有后续版本的限制。TUI、状态栏、Desktop 面板、首次请求前和空闲时刷新仍需分开验收；本次 app-server 测试通过不代表这些界面已验收。

普通验证使用 `go test ./...`。数据库隔离、权限和窗口代次测试需专用 `TEST_DATABASE_URL`，未配置时跳过。实际上游搜索、Fast、摘要质量和 Desktop/TUI 展示仍需独立验收；协议测试不等于商业上游与客户端界面均已验证。
