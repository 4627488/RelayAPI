# CPA 能力对齐

Relay 使用根模块与 `third_party/cpaexecutor` 共同锁定的 CPA 版本。内置执行器、协议转换、OAuth、刷新、模型能力和上游错误语义由 CPA 实现；Relay 保留租户鉴权、模型权限、订阅准入、凭据钉住、额度、结算和日志。

## 上游

| 提供商标识 | API Key | OAuth | CPA 凭据 JSON 导入 |
| --- | --- | --- | --- |
| `codex` | 是 | 是 | 是 |
| `claude` / `anthropic` | 是 | 是 | 是 |
| `gemini` | 是 | — | 是 |
| `gemini-interactions` | 是 | — | 是 |
| `vertex` | 是 | — | 是，使用 CPA 的 Vertex 凭据格式 |
| `aistudio` | — | — | 是，另需连接浏览器执行通道 |
| `antigravity` | — | 是 | 是 |
| `kimi` | 是 | 是 | 是 |
| `xai` / `grok` | 是 | 是 | 是 |
| `devin` | — | 是 | 是 |
| `meta` / `muse` | — | 是 | 是 |
| `openai` | 是 | — | 是 |
| `openai-compatibility` | 是 | — | 是 |
| `aliyun-bailian` | 是 | — | 是，使用 OpenAI-compatible 执行器 |

OAuth 使用 CPA 提供的回调或设备码流程。授权、重新认证和令牌刷新保留现有的数据库凭据 ID、账户代理及订阅绑定。不要把未部署的插件提供商当作内置执行器导入；外部插件安装、独立 CPA 管理服务和配置文件生命周期不由这个嵌入式运行时启动。

Claude API Key 的默认 Base URL 是 `https://api.anthropic.com`，自定义地址应为根地址，CPA 自行添加 `/v1/messages`。Claude Code 可通过 `rai claude` 使用本站登录和模型选择；直连接入时设置 `ANTHROPIC_BASE_URL` 为本站根地址，`ANTHROPIC_AUTH_TOKEN` 为 Relay Key。

内置目录保留 CPA 的模型元数据、排除规则及别名，远程目录变化会重建路由和同步父订阅范围。OpenAI-compatible 服务继续通过账户自身的代理和凭据枚举上游模型。租户和 Key 的权限过滤同时作用于 OpenAI、Claude 和 Gemini 模型目录；Key 模型别名继承授权目标的元数据。

AI Studio 的浏览器执行通道使用管理员登录后的 `GET /api/admin/providers/accounts/{id}/ws` WebSocket 入口，连接已启用的 `aistudio` 账户。通道绑定该账户的数据库 ID；普通租户推理权限不能替换上游浏览器通道。模型请求仍从下面的公共协议入口进入正常准入与结算流程。

额度查询由 Relay 独立接入，不随 CPA 执行器注册自动获得。目前支持 Codex、Kimi、xAI 和 Claude OAuth 订阅账户。Claude 使用 `/api/oauth/usage` 查询 5 小时、7 天及模型专属窗口，沿用账户代理与令牌刷新；只有具有未来重置时间的账户整体窗口参与额度准入，模型专属和额外用量仅作展示。Claude API Key 账户不适用该订阅查询接口。查询失败保留已有快照并显示错误，不推断无限额度。该接口没有公开的稳定协议保证，部署后仍需真实订阅账户验收。

Claude 查询请求及响应形状依据 Claude Code 仓库中的实际调用记录：[OAuth usage 请求与限流报告](https://github.com/anthropics/claude-code/issues/30930)、[原始 utilization 百分比响应](https://github.com/anthropics/claude-code/issues/91406)、[模型专属及额外用量字段](https://github.com/anthropics/claude-code/issues/82656)。这些是调用记录，不是稳定 API 契约。

## 下游

| 协议 | CPA 入口 |
| --- | --- |
| OpenAI Chat / Text Completions | `POST /v1/chat/completions`、`POST /v1/completions` |
| Responses / compact | `POST /v1/responses`、`POST /v1/responses/compact` |
| Responses WebSocket | `GET /v1/responses`，另保留 Relay 的 `/v1/responses/ws` 别名 |
| Codex direct | `/backend-api/codex/responses`、`/backend-api/codex/responses/compact`、`/backend-api/codex/alpha/search` |
| Claude Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` |
| Gemini native | `GET /v1beta/models`、`GET /v1beta/models/{model}`、`POST /v1beta/models/{model}:generateContent`、`:streamGenerateContent`、`:countTokens` |
| Gemini Interactions | `POST /v1beta/interactions` |
| 模型目录 | `GET /v1/models`，保持 CPA 的 OpenAI、Claude、Codex 客户端格式 |
| 图片 | `POST /v1/images/generations`、`POST /v1/images/edits` |
| xAI 视频 | `POST /v1/videos`、`/v1/videos/generations`、`/v1/videos/edits`、`/v1/videos/extensions`，`GET /v1/videos/{request_id}` |
| OpenAI 视频 | `POST /openai/v1/videos`，`GET /openai/v1/videos/{video_id}`、`/content` |
| Realtime / Live | CPA 的 `/v1/realtime`、`/v1/realtime/calls`、`/v1/realtime/client_secrets`、`/v1/realtime/sessions`、`/v1/live`、会话侧通道、翻译与 SIP 控制路由 |
| Codex search | `POST /v1/alpha/search` |

公共请求接受 Bearer、`X-Api-Key`、`X-Goog-Api-Key` 以及 CPA 的 `key` / `auth_token` 查询鉴权。查询凭据在进入运行时之前移除。Gemini 的 URL 模型名参与别名解析、权限检查、订阅选择和计费，不能用 JSON 中另一模型名绕过。

Token 计数和 Realtime 临时凭据签发是已知零费用操作，仍需要对应模型权限与订阅准入。计数值不会累计成生成 Token。Realtime 临时凭据使用加密 Relay 包装，绑定签发 Key、模型和 CPA 的有效期；每次使用重新检查 Key 状态。内部 CPA 接收不同 Relay Key 的独立身份，使会话归属检查继续有效。临时凭据不保存在请求日志中。

CPA 支持的协议组合由所选上游模型实际能力决定。路由存在不表示每个提供商都具有图片、视频、实时音频或任意工具能力。没有完整生成用量的响应继续使用 Relay 的保守结算规则；不把缺失用量当作免费生成。

## 验证

回归覆盖内置执行器及 CPA 目录一致性、Claude 与 Gemini 的原生及 OpenAI 转换、Claude 用量回调、目录权限及别名、Gemini URL 模型解析、零费用计数、Realtime 服务端首帧、临时凭据加密/篡改/过期及会话身份隔离。协议测试使用模拟上游；真实账户、WebRTC 网络条件、SIP 和浏览器执行环境仍需部署环境验收。

已通过 Windows 与 Linux/PostgreSQL 的全量 Go race 回归、桥接模块的全量 race 回归、根模块与桥接模块的 `go vet`，以及前端格式、类型、Lint、91 项测试和生产构建检查。
