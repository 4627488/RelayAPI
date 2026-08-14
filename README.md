# RelayAPI

RelayAPI 是内置 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 执行器的
Go 多租户模型网关。默认 `native` 数据平面在同一进程内完成协议兼容、凭据路由、
额度、计费和审计，不需要单独运行 CLIProxyAPI 服务。

详细设计见 [docs/architecture.md](docs/architecture.md)，生图计费与生产费率见
[docs/image-billing.md](docs/image-billing.md)，父/子订阅与严格凭据路由见
[docs/subscriptions.md](docs/subscriptions.md)。

## 启动

需要 Go 1.26+ 和 PostgreSQL。

```bash
cp .env.example .env
docker compose up --build
```

Compose 中单个 RelayAPI 镜像同时提供前端与统一 API 入口，默认监听
`http://localhost:8080`。租户将 `base_url` 指向统一入口并使用
`relay_*` 密钥。可用模型通过 `GET /v1/models` 实时获取。

## 前端

`web/` 是基于 Vite、React 19、Tailwind CSS v4 和 shadcn/ui Nova（Base UI）
构建的独立源码应用。生产镜像会把其构建产物打包进 Go 服务，因此部署时不再需要
单独的 Web/Nginx 容器。

```bash
cd web
pnpm install
pnpm dev
```

开发服务器会将 `/api`、`/v1` 和健康检查请求代理到
`http://localhost:3000`。生产环境由 Go 服务直接提供 SPA、HTTP、SSE 和
WebSocket 入口。

镜像、版本标签和推荐部署方式见 [docs/distribution.md](docs/distribution.md)。

## 必需配置

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL DSN |
| `RELAY_SESSION_SECRET` | Cookie 签名密钥（至少 32 字符） |
| `RELAY_API_KEY_ENCRYPTION_KEY` | API Key 静态加密密钥（至少 32 字符，必须稳定备份） |

`RELAY_API_KEY_ENCRYPTION_KEY` 未设置时兼容性回退到 `RELAY_SESSION_SECRET`。生产环境
建议单独设置且持久备份；直接更换会导致已有 Key 无法再次显示，但不会影响其哈希鉴权。

RelayAPI 只使用内嵌 CPA 数据面，不需要单独部署 CLIProxyAPI、bridge 插件或选择
数据面模式。HTTP、SSE 与 WebSocket 都通过同一个内嵌 CPA 运行时完成协议转换、
凭据选择和上游连接。

RelayAPI 默认完整保留 CPA 原生 Codex/xAI WebSocket：一个客户端连接可承载多轮
`response.create` / `response.append`，复用上游连接、会话状态和凭据亲和性。Relay
会按顺序转发当前轮终态与上游断线，避免断线通知抢先关闭客户端连接；完整的新一轮
可自动重连上游，依赖已丢失上游状态的增量轮次会返回标准 `1012` 要求完整重放。
只有在提供商本身不支持稳定 WebSocket 时，才设置
`RELAY_UPSTREAM_WEBSOCKETS=true`（默认）会为 CPA 支持的 Codex/xAI 凭据明确启用原生上游 WebSocket；这也适用于未携带 `websockets` 字段的旧导入凭据。设为 `false` 时统一使用 HTTP 流式回退。该运行时策略不会改写数据库中加密保存的凭据文档。

内置执行器由 RelayAPI 的准入控制保护：推理请求默认最多 16 个并发、32 个等待者，排队最多 2 秒；单请求体默认最多
1 GiB，所有在途请求体合计最多 8 GiB。单请求可配置到 64 GiB，在途预算可配置到 256 GiB。连续 3 次
上游传输故障后熔断 15 秒，恢复时只允许一个探针。`CPA_REQUEST_TIMEOUT_SECONDS`
只限制等待响应头，不会中断已经开始的 SSE/WebSocket。推理与管理路径使用独立
连接池。上述值均可用 `.env.example` 中的 `CPA_*`
兼容命名参数调整；默认 Compose 内存上限为 16 GiB。提高并发或请求体上限时应同步提高 RelayAPI 内存预算。

## 客户端兼容

Relay 对外提供 OpenAI Responses、OpenAI Chat Completions 和 Codex direct 路径。
Grok/xAI、Kimi 与其他 OpenAI-compatible 模型共用 `/v1/chat/completions` 或
`/v1/responses`，由请求中的 `model` 和 native
凭据配置选择提供商。管理员可在“模型账户”中管理加密凭据，在独立“代理”页面维护和
测试可复用代理，在“系统设置”中选择系统请求代理并热更新重试、调度、图像/视频和连接行为。
系统代理仅用于 Models.dev 同步、系统级 OAuth 等 RelayAPI 自身请求；每个模型账户单独
选择代理，未选择时明确直连。账户代理同时作用于推理、模型发现、令牌刷新和额度查询。

模型账户使用内嵌运行时的凭据级模型目录：Codex、Kimi 和 xAI 使用受控静态目录；OpenAI 及
OpenAI-compatible 凭据由 CPA executor 携带同一凭据、代理和自定义请求头访问上游
`GET {base_url}/models`。模型账户不接受自由填写模型名；管理员只能从 CPA 返回的
凭据目录中勾选公开范围，后端保存时会再次校验，避免把不存在或不兼容的模型注册进
路由。若兼容服务不提供可枚举的模型目录，该凭据暂不能通过自动接入创建。

阿里云百炼作为 OpenAI-compatible 提供商接入。默认北京公共 Base URL 为
`https://dashscope.aliyuncs.com/compatible-mode/v1`；业务空间、其他地域、Token Plan 或
Coding Plan 必须填写与 API Key 匹配的 Base URL。客户端仍可使用 Chat Completions 或
Responses；百炼请求会统一由 CPA 转换为 Responses 格式并发送到上游 `/v1/responses`，
同时由 CPA 将响应转换回客户端协议。CPA 继续通过兼容端点枚举模型；仅支持 DashScope
专用协议的模型不在该接入范围内。

用户面板的“接入向导”会生成 5 分钟有效的一键 Bash 或 PowerShell 命令，可同时
配置 Codex 与 OpenCode。脚本先验证 `/v1/models`，可选择安装缺失
客户端，并以备份、合并、原子替换和失败回滚方式写用户级配置；两个客户端通过
权限受限的 `~/.config/relayapi/api-key` 共用凭据，不向 shell profile 或 Codex
`auth.json` 写入明文。OpenCode 配置会包含该 API Key 当前可用的完整模型列表；
重复执行脚本会替换 RelayAPI 管理的模型集合，避免已撤销模型继续出现在选择器中。
下面的片段仅作为无法执行脚本时的手动回退。

Codex CLI 的 `~/.codex/config.toml`（`base_url` 必须包含 `/v1`）：

```toml
model = "你的-codex-模型"
model_provider = "relay"

[model_providers.relay]
name = "RelayAPI"
base_url = "http://localhost:8080/v1"
env_key = "RELAY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
supports_standalone_web_search = true

[features]
apps = true
```

```bash
export RELAY_API_KEY=relay_xxx
```

这些字段与当前 [Codex 配置参考](https://developers.openai.com/codex/config-reference)
一致；Relay 同时透传 `/v1/responses/ws`，并在 Codex 私有模型目录中默认声明完整的
代理、图片、搜索、Apps、Skills、Plugins、并行工具和多代理能力。不能承受乐观能力
声明的上游可在系统设置中切换到 `verified` 严格模式。

OpenCode 可选择 Chat Completions 或 Responses；下面是 Chat Completions 配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "relay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "RelayAPI",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "{env:RELAY_API_KEY}"
      },
      "models": {
        "你的模型 ID": { "name": "你的模型显示名" }
      }
    }
  }
}
```

Responses 模型把 `npm` 改为 `@ai-sdk/openai`。这一区分来自
[OpenCode provider 文档](https://opencode.ai/docs/providers)。
未知模型默认允许调用且不扣费；
设置 `UNPRICED_MODEL_POLICY=deny` 可改为严格模式。
定价按“管理员覆盖 > Models.dev 在线目录 > 内置最后可用目录”解析，支持模型别名、
CPA 多维倍率规则和分模态费率快照（文本五段加图片输入、缓存图片输入、图片输出）。
请求日志采用分层留存：成功且定价完整的请求默认
只抽样 1% 保存完整内容并保留 1 天，错误或定价不完整的详情保留 14 天，请求摘要
保留 30 天。摘要过期前会原子汇总到每日用量表，因此长期用量、模型和费用报表不会
随原始日志删除。生命周期事件、请求预留、额度观测和失效邀请也会小批量自动清理；
完整配置见 `.env.example`。

## 面板 API

管理员后端：

- 首个注册用户自动获得管理员身份；已有数据库升级时，最早创建的用户会成为管理员
- 管理员使用普通用户邮箱和密码登录，再从左下角用户信息块切换到管理员面板
- `GET /api/admin/overview`：用户、Key、邀请和今日用量总览
- `GET|POST /api/admin/invitations`：查看或生成单次邀请
- `DELETE /api/admin/invitations/{id}`：撤销邀请
- `GET /api/admin/tenants`：用户列表
- `GET|POST /api/admin/providers/accounts`：管理数据库加密保存的原生凭据
- `GET|POST /api/admin/proxies`、`PATCH|DELETE /api/admin/proxies/{id}`：管理可复用的加密代理条目
- `POST /api/admin/proxies/{id}/test`：测试代理并返回落地 IP、归属、ASN/运营商和延迟
- `GET|PATCH /api/admin/runtime/settings`：系统代理、重试与凭据调度策略
- `GET /api/admin/usage?days=30&user_id=...`：全局或指定用户用量
- `GET /api/admin/logs?tenant_id=...&page=1&page_size=50`：可搜索、筛选和分页的请求日志
- `GET /api/admin/logs/{id}`：脱敏请求、CPA 转发、上游响应、耗时与历史计费详情
- `/api/admin/prices`：管理员文本与图片分模态价格覆盖
- `/api/admin/pricing/aliases`、`/api/admin/pricing/rules`：模型别名与 CPA 多维倍率
- `GET|POST /api/admin/pricing/sync`：预览或应用 Models.dev 价格目录
- `POST /api/admin/subscriptions/sync`：同步原生凭据与父订阅身份
- `POST /api/admin/subscriptions/quota/sync`：立即通过内嵌适配器观测所有父订阅额度
- `POST /api/admin/subscriptions/parents/{id}/quota/sync`：观测单个父订阅额度
- `/api/admin/subscriptions/parents/*`：父订阅、任意容量窗口与观测样本
- `/api/admin/subscriptions/children/*`：向租户分配、停用或回收子订阅

原生凭据页和父订阅页都会展示最近一次脱敏上游额度快照。RelayAPI 默认每 5 分钟
直接使用加密凭据观测 Codex 和 xAI 额度，不依赖外置 CPA 或插件。自动观测模式不要求
填写窗口名称、百分比或重置时间，管理员只填写每个已观测窗口对应的 USD 容量。
父/子订阅的模型范围从 CPA 已同步的实际可用模型中多选，空选择表示继承全部模型。

用户后端：

- `GET /api/auth/status`：判断全新实例是否需要创建首个管理员用户
- `POST /api/auth/register`：首用户无邀请初始化；后续用户使用邀请 token 注册
- `POST /api/auth/login`：登录
- `GET /api/dashboard`：账户与近 30 天概览
- `GET /api/usage?days=30`：按天、模型和 API Key 聚合的个人用量
- `GET|POST /api/keys`：查看或生成个人 API Key，可限制启用模型并配置 Key 私有模型别名
- `GET /api/keys/{id}/secret`：按需读取自己可恢复的完整 API Key（禁止缓存）
- `PUT /api/keys/{id}`：编辑 API Key 名称、额度、启用模型和模型别名
- `DELETE /api/keys/{id}`：删除个人 API Key
- `GET /api/logs`、`GET /api/logs/{id}`：个人范围内的日志查询和详细链路
- `GET /api/subscriptions`：个人子订阅、已用额度和上游重置时间
- `POST /api/agent-setup`：创建 5 分钟有效的短随机安装令牌与跨平台一键命令；数据库只保存令牌哈希和加密配置
- `GET /setup/{token}/install.sh|install.ps1`：读取禁止缓存的短时安装脚本

创建邀请时仅在响应中返回一次明文 token。数据库只保存 SHA-256 哈希；邀请可
限制注册邮箱，并支持过期、使用和撤销状态。

API Key 与邀请不同：新 Key 同时保存用于鉴权的 SHA-256 哈希和使用
`RELAY_API_KEY_ENCRYPTION_KEY` 保护的 AES-GCM 密文，因此所属用户可随时按需查看。
列表接口永不包含明文，解密接口禁止缓存；升级前只有哈希的旧 Key 仍可正常鉴权，
但无法恢复明文，需要新建 Key 后逐步替换。

API Key 模型别名是客户端可见的附加入口。例如将 `fast` 指向
`qwen-plus` 后，客户端可以用 `fast` 发起请求。RelayAPI 会先解析别名，
再以实际模型执行 Key/租户权限检查、订阅准入和计费，最后交给 CPA 完成提供商路由
和协议转换。空模型范围仍表示继承全部可用模型；别名不会绕过模型范围限制。

## 验证

```bash
go test ./...
go vet ./...
```

## 内嵌 CPA 边界

RelayAPI 在进程内启动 CPA 的完整推理路由。外层负责租户鉴权、准入、计费和审计；
内层负责协议语义、模型路由、凭据选择、重试及 WebSocket 会话状态。Relay 自有的
`internal/upstream.Runtime` 隔离了 CPA 类型，并在提供商边界修复 Codex 工具语义；
例如 Grok 不原生接受的 freeform `apply_patch` 会被可逆地降级成 string-input
function，响应再恢复成标准 `custom_tool_call`。Responses
WebSocket 的首帧与后续帧都透明交给内层处理，Relay 只读取终态事件中的 usage 并
按连接内所有轮次累计结算。旧的外置 CPA 数据面、C-ABI bridge 和直连 executor
适配层均已移除。当前 CPA 只作为进程内兼容运行时使用，并可按提供商逐步替换，
不会再向业务、计费或 HTTP 层泄漏其注册表与执行器类型。
