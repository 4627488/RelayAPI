# Claude Desktop 网关兼容

RelayAPI 为 Claude Desktop 的 Chat、Code、Cowork 提供 Anthropic Messages 网关。`rai` 负责本机配置档和凭据助手，模型目录与调用权限由服务器控制。本机已有的插件、项目、目录权限和其他配置档继续保留。

```sh
rai configure claude-desktop --reasoning-effort medium --yes
# 完全退出并重新打开 Claude Desktop
```

## 模型发现与能力

新服务器在 `/api/rai/session` 返回 `claude.version=1` 和 `model_discovery=true`。未固定模型时，rai 开启 Desktop 的模型发现并移除静态 `inferenceModels`，避免完整静态模型 ID 列表阻止客户端查询 `/v1/models`。模型权限、目录和能力改变后，新启动的客户端可获取更新。

以下情况仍使用静态列表：显式 `--model`、rai profile 已保存原生 Claude 默认模型、所选模型是客户端不能自动识别的别名，或旧服务器没有协商发现能力。静态列表把选择的模型放在首位，保留原有默认模型行为。

服务器在授权与别名过滤之后增加 Desktop 识别的 `anthropic_family_tier`、`is_family_default`、`display_name`、`behaves_as`、`max_input_tokens`、`max_output_tokens` 和 `supports_1m`。同一家族默认选择最新版本；其他提供方的元数据保留。非 Claude 目标不会因客户端别名长得像 Claude 而获得 Claude 家族标记。

上下文能力使用可信目录资料和管理员覆盖，管理员覆盖优先；输入上限小于上下文窗口时使用较小值。未知窗口不推断为 1M。非 Codex 模型列表的 ETag 覆盖实际响应，能力变化会使旧条件请求失效。权限仍由每次推理的服务端检查执行，客户端目录不是访问授权。

## MCP 工具搜索

Desktop 的 Gateway 模式需要 `toolSearchEnabled`；终端 Claude Code 的 `ENABLE_TOOL_SEARCH` 不能替代这个开关。rai 只有在 session 明确声明所选模型支持工具搜索时才开启它；旧服务器、未知能力和未确认的自定义上游保持关闭。

服务器从嵌入式 CPA 的实际路由与 executor 能力获取 `model_info[id].canonical_model` 和 `tool_search`，不按名称猜测传输能力。相同公开 ID 的全部账户路由必须属于 Claude 且映射到同一目标；混合提供方或不同目标的模型不声明原生工具搜索。观测包装器继续暴露 executor 的能力接口。

Anthropic 原生端点使用 CPA 的原生能力判断。自定义 Claude 上游只有在其凭据文档明确设置布尔值 `native_tool_search: true` 时才允许声明；设置前需确认该部署接受工具搜索 beta、`defer_loading` 和 `tool_reference`。这不是通过开关模拟上游能力。旧模型的工具搜索支持仍由 CPA 和客户端共同判断。

## 缓存、流式响应与压缩

原生 Messages 继续经过 CPA 的原生 executor，不经 OpenAI Chat 转换。Relay 不重建客户端的系统提示词、工具结果或缓存断点。协议测试验证系统和消息中的缓存标记、1h TTL、延迟加载工具、工具引用、adaptive thinking、未知安全检查字段、工具调用 ID 和缓存 usage 均可往返。

流式响应设置 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`。真实 HTTP 测试阻塞上游的最终输出，确认客户端仍能先收到 SSE ping；外部反向代理和负载均衡器也必须关闭缓冲，并给压缩等长请求足够的超时。应用测试不能证明生产入口的超时设置。

上游的上下文过长错误保留原状态码、错误结构和消息语义，使客户端能触发压缩重试。请求中带有缓存字段和响应中带有缓存 usage，只证明协议保留；缓存是否命中、1h TTL 和 1M 请求是否被商业上游接受，仍需对实际账户验证。

## 自动审批与额度提示

rai 明确设置 `inferenceGatewayAutoModeServerChecks=false`，使用客户端内置的安全检查，不因网关能够透传字段就宣称上游能返回服务端审批结果。协议测试中的 `safeguards` / `safeguard_results` 仅验证透明转发，不构成上游提供审批服务的证明。是否允许 Auto mode 仍由 Desktop 的模型支持与现有权限策略决定。

Relay 自己拒绝 Messages 调用时使用 Anthropic 错误信封；余额或订阅额度耗尽返回 HTTP 402 与 `billing_error`。`x-should-retry` 明确区分可重试错误和固定额度/权限问题。其他协议仍保留原错误类型，上游错误不会被替换为本地账单错误。

## 可选的自建搜索

```sh
rai configure claude-desktop --web-search-url https://search.example.com/v1/search --yes
```

这个参数配置 Desktop 内置的 `websearch` 连接器，选择 `custom` provider，不新增模型代理层。搜索端点按官方协议接收 `POST {"q":"..."}`，在 15 秒内返回 `{"results":[{"title":"...","url":"...","snippet":"..."}]}`。rai 不向搜索服务发送 Relay 登录凭据；需要鉴权时，在 Desktop 的连接器设置中为搜索端点配置独立的 headers/helper。

已有其他搜索提供方时，命令会要求先在 Desktop 修改，避免把原有 vendor key 带到新地址。其他 MCP 连接器保留；unconfigure 仅恢复未被用户修改的 rai 搜索条目。没有传这个参数时，已有搜索配置不变。

网页搜索与网页抓取分别控制。`coworkEgressAllowedHosts` 由用户按工作需要配置；rai 不自动放开全部域名。Brave、Tavily、Exa、其他远程 MCP 和原生上游搜索也可在 Desktop 中按官方方式配置。

## 参考与验证边界

- [Anthropic Desktop Gateway](https://claude.com/docs/third-party/claude-desktop/gateway)：模型发现、缓存、工具搜索、服务端安全检查和账单错误。
- [Anthropic Web tools](https://claude.com/docs/third-party/claude-desktop/web-tools)：内置搜索、custom 搜索协议和网页抓取权限。
- [LiteLLM Anthropic Passthrough](https://docs.litellm.ai/docs/pass_through/anthropic_completion)：保留原生协议，同时进行认证、计量和流式转发。
- [Sub2API 缓存断点改写问题](https://github.com/Wei-Shaw/sub2api/issues/2369)与[延迟工具缓存冲突](https://github.com/Wei-Shaw/sub2api/issues/4990)：作为避免重复注入缓存策略的兼容性案例，不将第三方问题描述当作当前 Relay 的故障证据。

测试使用本地 HTTP 上游和真实嵌入式 CPA，不调用商业模型。原生调用、能力协商和 HTTP 流式行为有自动化验证；Desktop GUI、真实搜索供应商、生产反代、商业账户 1M 与缓存命中率需要分别验收。配置能力不提供 claude.ai 云端历史同步、手机访问或官方订阅额度。没有新增 bootstrap/SSO 控制面；现有 rai 凭据助手继续负责短期凭据续期。
