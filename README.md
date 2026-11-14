# RelayAPI

RelayAPI 是仅分发 Codex 的 Go 多租户 Responses 网关，负责加密凭据、账户调度、额度、计费和审计。执行器在进程内运行，不依赖 CPA 或本地协议转换进程。

客户端直接使用 OpenAI Responses；其他客户端通过本地 Magpie 转换后接入，参见 [Magpie 接入与额度说明](docs/magpie.md)。服务端不提供 Chat Completions、Messages、Gemini、Images、视频或 Realtime API。计量口径见 [请求计量与结算](docs/billing-step-logs.md)，订阅规则见 [父子订阅](docs/subscriptions.md)。

## 启动

需要 Go 1.26+ 和 PostgreSQL。

本机 Windows 开发可使用 [WSLC 开发容器](docs/development-container.md)，包含 Go、pnpm、Chromium 和独立的开发/测试 PostgreSQL 数据库。

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

可选 [GitHub 登录](docs/github-login.md)：已有用户在「账户设置」验证当前密码后主动绑定，之后可使用 GitHub 登录。新用户仍使用现有邀请注册流程。

## 必需配置

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL DSN |
| `RELAY_SESSION_SECRET` | Cookie 签名密钥（至少 32 字符） |
| `RELAY_API_KEY_ENCRYPTION_KEY` | API Key 静态加密密钥（至少 32 字符，必须稳定备份） |

`RELAY_API_KEY_ENCRYPTION_KEY` 未设置时兼容性回退到 `RELAY_SESSION_SECRET`。生产环境
建议单独设置且持久备份；直接更换会导致已有 Key 无法再次显示，但不会影响其哈希鉴权。

RelayAPI 使用自有的原生数据面，不需要部署第三方代理服务或插件。HTTP、SSE 与
WebSocket 由同一套运行时完成协议转换、凭据选择、重试和上游连接。

管理端“运行策略”只暴露可热更新且确实生效的控制：凭据调度、临时故障重试、逐凭据
故障隔离与系统代理。Codex 能力元数据固定完整声明，响应头固定采用安全白名单；这类
协议正确性和安全边界不提供容易误配的开关。账户模型重名请使用 API Key 模型别名或
严格订阅绑定处理，不再维护会破坏权限命名一致性的账户级模型前缀。

Codex Responses WebSocket 支持连接内多轮 `response.create`。收到一轮终态后即使上游断开，
客户端连接仍会保留，下一次完整请求会自动重连；`generate:false` 透传上游完成真实预热，保留可用于续接的响应 ID。
`RELAY_UPSTREAM_WEBSOCKETS=true` 默认启用这条链路，关闭后可统一使用 HTTP 流式接口。

原生执行器由 RelayAPI 的准入控制保护：推理请求默认最多 8 个并发、16 个等待者，排队最多 2 秒。
进程边界（响应头超时、请求体上限、在途内存、内存回收、未定价模型、上游 WebSocket）在管理端「运行策略」里热更新，默认按宽松上限运行：响应头等待 24 小时、单请求 1 GiB、在途合计 8 GiB。
这些值不再依赖重启。凭据级故障隔离仍然生效；进程级全局熔断默认关闭，避免几次传输失败就把整站拦掉。
提高并发或请求体上限时，请同步提高主机内存预算。

## 客户端接入

支持 `POST /v1/responses`、`POST /v1/responses/compact`、Responses WebSocket 和 `GET /v1/models`。保留 `/openai/v1` 与 `/backend-api/codex` 命名空间供 Codex 客户端使用。

Magpie 中将 RelayAPI 配置为 Responses 提供商：地址为 `https://你的域名/v1`，密钥为 `relay_*`。面板的 Magpie 导入链接只声明 Responses 地址和余额查询，不声明其他协议；本地 Magpie 负责客户端协议适配。

仅 Codex 凭据可以新增或加载到执行器。历史其他提供商凭据和账单保留在数据库中，不参与分发。账户代理作用于推理、模型发现、Token 刷新和额度查询；未选择时明确直连。

Codex OAuth 账户使用 PKCE 登录并加密保存授权。执行前刷新过期 Token；上游明确返回 401 时只允许刷新后在同一账户再请求一次，不跨越准入时固定的账户。其他失败原样返回，避免重复提交生成。

原生 Responses 工具和扩展字段保持原协议。ChatGPT Codex 后端要求的 `store:false`、流式传输及输入列表规范在执行边界处理；非流式 Responses 会聚合终态响应。这不是跨协议转换。

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
- `GET|PATCH /api/admin/runtime/settings`：凭据调度、隔离、系统代理，以及可热更新的进程边界
- `GET /api/admin/usage?days=30&user_id=...`：全局或指定用户用量
- `GET /api/admin/logs?tenant_id=...&page=1&page_size=50`：可搜索、筛选和分页的请求日志
- `GET /api/admin/logs/{id}`：脱敏请求、Relay 原生运行时 转发、上游响应、耗时与历史计费详情
- `/api/admin/prices`：管理员文本与图片分模态价格覆盖
- `/api/admin/pricing/aliases`、`/api/admin/pricing/rules`：模型别名与 Relay 原生运行时 多维倍率
- `GET|POST /api/admin/pricing/sync`：预览或应用 Models.dev 价格目录
- `POST /api/admin/subscriptions/sync`：同步原生凭据与父订阅身份
- `POST /api/admin/subscriptions/quota/sync`：立即通过内嵌适配器观测所有父订阅额度
- `POST /api/admin/subscriptions/parents/{id}/quota/sync`：观测单个父订阅额度
- `/api/admin/subscriptions/parents/*`：父订阅、任意容量窗口与观测样本
- `/api/admin/subscriptions/children/*`：向租户分配、停用或回收子订阅

原生凭据页和父订阅页都会展示最近一次脱敏上游额度快照。RelayAPI 启动 15 秒后首次观测，
此后默认每 30 秒使用加密凭据观测 Codex 额度；可用
`RELAY_QUOTA_SYNC_INTERVAL_SECONDS` 调整周期，最短 10 秒。探测耗时超过周期时不会并发叠加。
额度观测不依赖外置 Relay 原生运行时或插件。自动观测模式不要求
填写窗口名称、百分比或重置时间，管理员只填写每个已观测窗口对应的 USD 容量。
父/子订阅的模型范围从 Relay 原生运行时 已同步的实际可用模型中多选，空选择表示继承全部模型。

管理员在「模型账户 → Codex 账户详情 → 状态」可查询 Banked resets（积攒的重置次数）及每条记录的到期时间，并手动使用一次。此处的到期时间属于重置记录，区别于授权令牌或订阅到期。查询与使用复用原生运行时的凭据刷新和账户代理，分别请求 Codex 的 `/backend-api/wham/rate-limit-reset-credits` 和 `/consume`；实现依据 [Codex 官方客户端](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs) 和 [官方说明](https://learn.chatgpt.com/zh-Hans/docs/app-server)。未提供数据或查询失败不会显示为零次。使用需在界面确认，同一浏览器会话内的失败重试保留请求标识，避免重复消耗；完成后刷新次数及关联父订阅的额度快照。

- `GET /api/admin/providers/accounts/{name}/codex-reset-credits`：实时查询可用次数和到期明细
- `POST /api/admin/providers/accounts/{name}/codex-reset-credits/consume`：手动使用，提交 `redeem_request_id`（UUID）及可选 `credit_id`，失败重试须复用同一 UUID

用户后端：

- `GET /api/auth/status`：判断全新实例是否需要创建首个管理员用户
- `POST /api/auth/register`：首用户无邀请初始化；后续用户使用邀请 token 注册
- `POST /api/auth/login`：登录
- `GET /api/dashboard`：账户与近 30 天概览
- `GET /api/usage?days=30&timezone=Asia/Singapore`：按天、模型和 API Key 聚合的个人用量
- `GET|POST /api/keys`：查看或生成个人 API Key，可限制启用模型并配置 Key 私有模型别名
- `GET /api/keys/{id}/secret`：按需读取自己可恢复的完整 API Key（禁止缓存）
- `PUT /api/keys/{id}`：编辑 API Key 名称、额度、启用模型和模型别名
- `DELETE /api/keys/{id}`：删除个人 API Key
- `GET /api/logs`、`GET /api/logs/{id}`：个人范围内的日志查询和详细链路
- `GET /api/subscriptions`：个人子订阅、已用额度和上游重置时间
- `GET /v1/usage`：使用当前 API Key 读取 sub2api 兼容的现金余额、订阅摘要和适用的原生额度窗口
- `GET /api/rai/quota`：使用当前 RAI API Key 读取其可访问的子订阅额度窗口
- `GET /rai/install.sh|install.ps1`：本站下发的 rai 安装脚本，从 `/rai/download/{os}-{arch}` 取与当前部署同构建的二进制，再对 PublicURL 执行 `rai login`
- `GET /rai/download/{os}-{arch}`：本站随镜像发布的 rai 二进制（darwin/linux/windows × amd64/arm64）
- `POST /api/agent-setup`：创建 5 分钟有效的短随机安装令牌与跨平台一键命令；数据库只保存令牌哈希和加密配置
- `GET /setup/{token}/install.sh|install.ps1`：读取禁止缓存的短时安装脚本

创建邀请时仅在响应中返回一次明文 token。数据库只保存 SHA-256 哈希；邀请可
限制注册邮箱，并支持过期、使用和撤销状态。

API Key 与邀请不同：新 Key 同时保存用于鉴权的 SHA-256 哈希和使用
`RELAY_API_KEY_ENCRYPTION_KEY` 保护的 AES-GCM 密文，因此所属用户可随时按需查看。
列表接口永不包含明文，解密接口禁止缓存；升级前只有哈希的旧 Key 仍可正常鉴权，
但无法恢复明文，需要新建 Key 后逐步替换。

API Key 模型别名是客户端可见的附加入口。例如将 `fast` 指向
`gpt-5.5` 后，客户端可以用 `fast` 发起请求。RelayAPI 会先解析别名，
再以实际模型执行 Key/租户权限检查、订阅准入和计费，最后交给原生运行时
发送 Codex Responses 请求。空模型范围仍表示继承全部可用模型；别名不会绕过模型范围限制。

## 验证

```bash
go test ./...
go vet ./...
```

## 原生运行时边界

`internal/upstream.Runtime` 在进程内执行 Codex Responses HTTP 和 WebSocket 请求。外层负责鉴权、准入和结算，内层只允许已固定且拥有目标模型的凭据执行。没有 CPA 回环服务、第三方执行器模块或 Cursor SDK。

计量使用 Magpie 的普通输入、缓存读取和缓存写入独立口径；推理包含在输出中，不重复计费。只按实际响应中完整且可信的 usage 结算，未知用量或价格不推算扣费，历史账单不会随运行时切换重算。
