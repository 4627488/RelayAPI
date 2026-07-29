# RelayAPI

RelayAPI 是位于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
前面的 Go 多租户网关。CLIProxyAPI 负责模型/提供商协议互操作，RelayAPI 负责租户
API Key、额度、计费和审计。因此 CLIProxyAPI 新增模型后无需修改 RelayAPI。

详细设计见 [docs/architecture.md](docs/architecture.md)，父/子订阅与严格凭据路由见
[docs/subscriptions.md](docs/subscriptions.md)。

## 启动

需要 Go 1.24+、PostgreSQL 和一个已配置的 CLIProxyAPI 实例。

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
| `CPA_URL` | CLIProxyAPI 私网地址 |
| `CPA_API_KEY` | RelayAPI 访问 CLIProxyAPI 的 API Key |
| `RELAY_ADMIN_KEY` | 管理员登录密钥（至少 16 字符） |
| `RELAY_SESSION_SECRET` | Cookie 签名密钥（至少 32 字符） |

`CPA_MANAGEMENT_KEY` 用于管理员面板中的 CPA 凭据、Codex OAuth 与运行策略管理。
`CPA_PLUGIN_SECRET` 用于 CPA bridge 与 Relay 相互认证。仅使用遥测时可不配置；
启用父/子订阅的严格 AuthID 路由时必须配置，并与 CPA 插件配置一致。
未知模型默认允许调用且不扣费；
设置 `UNPRICED_MODEL_POLICY=deny` 可改为严格模式。

## 面板 API

管理员后端：

- `POST /api/auth/admin`：管理员登录
- `GET /api/admin/overview`：用户、Key、邀请和今日用量总览
- `GET|POST /api/admin/invitations`：查看或生成单次邀请
- `DELETE /api/admin/invitations/{id}`：撤销邀请
- `GET /api/admin/tenants`：用户列表
- `GET /api/admin/providers/accounts`：CPA 脱敏凭据列表
- `POST /api/admin/providers/{provider}/oauth`：发起 Codex、Anthropic、
  Antigravity、Kimi 或 xAI OAuth/设备授权
- `POST /api/admin/providers/oauth/callback`：提交 OAuth 回调
- `GET|PATCH /api/admin/providers/settings`：重试与凭据调度策略
- `/api/admin/cpa/*`：管理员会话保护的 CLIProxyAPI Management API 完整桥接；
  保留方法、查询参数及 JSON/YAML/上传请求体
- `GET /api/admin/usage?days=30&user_id=...`：全局或指定用户用量
- `GET /api/logs?tenant_id=...`：请求日志
- `POST /api/admin/subscriptions/sync`：从 CPA AuthID 同步父订阅
- `/api/admin/subscriptions/parents/*`：父订阅、任意容量窗口与观测样本
- `/api/admin/subscriptions/children/*`：向租户分配、停用或回收子订阅

用户后端：

- `POST /api/auth/register`：使用邀请 token 注册
- `POST /api/auth/login`：登录
- `GET /api/dashboard`：账户与近 30 天概览
- `GET /api/usage?days=30`：按天、模型聚合的个人用量
- `GET|POST /api/keys`：查看或生成个人 API Key
- `DELETE /api/keys/{id}`：删除个人 API Key
- `GET /api/logs`：个人请求日志
- `GET /api/subscriptions`：个人子订阅、已用额度和上游重置时间

创建邀请时仅在响应中返回一次明文 token。数据库只保存 SHA-256 哈希；邀请可
限制注册邮箱，并支持过期、使用和撤销状态。

## 验证

```bash
go test ./...
go vet ./...
```

## CPA 薄插件

CPA bridge 发布为 `ghcr.io/4627488/relayapi-cpa-plugin`。普通余额计费可以不安装；
父/子订阅的 AuthID 固定路由要求 bridge `0.2.0+`。用附加 Compose 文件把动态库
放入 CPA 的私有插件目录：

```bash
docker compose -f docker-compose.yml -f docker-compose.plugin.yml up -d --build
```

在 CPA `config.yaml` 中启用：

```yaml
plugins:
  enabled: true
  dir: /CLIProxyAPI/plugins
  configs:
    relayapi-bridge:
      enabled: true
      priority: 10
      relay_url: http://relayapi:3000
      secret: 与 CPA_PLUGIN_SECRET 相同
      delegate: round-robin
```

插件负责 CPA 凭据选择扩展与用量/失败遥测。Relay 会用短时 HMAC 签名保护内部
AuthID 路由指令；指定凭据不在 CPA 当前候选集时，插件会拒绝请求而不会悄悄切换
到另一账户。计费仍使用 Relay 代理层关联到具体请求的响应用量，避免 CPA 插件
事件缺少自定义关联 ID 时发生串账。

## CLIProxyAPI 完整管理面

“模型账户”面板不仅提供脱敏凭据列表和常用路由策略，还能维护 CPA 网关 API
Keys、直接编辑完整 `config.yaml`，并调用任意 Management API。由此可以配置
Gemini、Claude、Codex、XAI、Vertex、OpenAI-compatible 提供商、OAuth 模型
别名/排除、代理、WebSocket、日志、插件与插件市场，以及 CPA 后续新增的管理
能力，而不需要 RelayAPI 维护一份易过期的提供商注册表。

面板同时提供结构化入口管理 Gemini、Interactions、Claude、Codex、xAI、Vertex、
OpenAI-compatible API Key，支持 OAuth 模型别名/排除、全局代理、WebSocket 鉴权、
额度耗尽切换、文件日志、插件市场、CPA Key 用量与事件队列。Kimi/xAI 的设备码
授权与需要粘贴 localhost 回调地址的 OAuth 流程会采用不同交互。

该桥仅允许 Relay 管理员会话访问，响应禁止缓存，CPA 本身仍应只位于私有网络。
若启用 YAML 在线编辑，`cliproxyapi/config.yaml` 必须可写；Compose 示例已按此配置。
