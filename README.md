# RelayAPI

RelayAPI 是位于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
前面的 Go 多租户网关。CLIProxyAPI 负责模型/提供商协议互操作，RelayAPI 负责租户
API Key、额度、计费和审计。因此 CLIProxyAPI 新增模型后无需修改 RelayAPI。

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 启动

需要 Go 1.24+、PostgreSQL 和一个已配置的 CLIProxyAPI 实例。

```bash
cp .env.example .env
docker compose up --build
```

Compose 中前端与统一 API 入口默认监听 `http://localhost:8080`，Go 后端仅在
私有容器网络监听 3000。租户将 `base_url` 指向统一入口并使用
`relay_*` 密钥。可用模型通过 `GET /v1/models` 实时获取。

## 前端

`web/` 是基于 Vite、React 19、Tailwind CSS v4 和 shadcn/ui Nova（Base UI）
构建的独立应用。它包含受邀注册、用户工作区和管理员控制台。

```bash
cd web
pnpm install
pnpm dev
```

开发服务器会将 `/api`、`/v1` 和健康检查请求代理到
`http://localhost:3000`。生产镜像通过 Nginx 提供 SPA，并代理 HTTP、SSE 和
WebSocket 请求到 Go 后端。

## 必需配置

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL DSN |
| `CPA_URL` | CLIProxyAPI 私网地址 |
| `CPA_API_KEY` | RelayAPI 访问 CLIProxyAPI 的 API Key |
| `RELAY_ADMIN_KEY` | 管理员登录密钥（至少 16 字符） |
| `RELAY_SESSION_SECRET` | Cookie 签名密钥（至少 32 字符） |

`CPA_MANAGEMENT_KEY` 用于管理员面板中的 CPA 凭据、Codex OAuth 与运行策略管理。
`CPA_PLUGIN_SECRET` 可选，用于 CPA 薄插件向 Relay 回传凭据级用量/失败遥测。
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
- `POST /api/admin/providers/codex/oauth`：发起 Codex OAuth
- `POST /api/admin/providers/oauth/callback`：提交 OAuth 回调
- `GET|PATCH /api/admin/providers/settings`：重试与凭据调度策略
- `GET /api/admin/usage?days=30&user_id=...`：全局或指定用户用量
- `GET /api/logs?tenant_id=...`：请求日志

用户后端：

- `POST /api/auth/register`：使用邀请 token 注册
- `POST /api/auth/login`：登录
- `GET /api/dashboard`：账户与近 30 天概览
- `GET /api/usage?days=30`：按天、模型聚合的个人用量
- `GET|POST /api/keys`：查看或生成个人 API Key
- `DELETE /api/keys/{id}`：删除个人 API Key
- `GET /api/logs`：个人请求日志

创建邀请时仅在响应中返回一次明文 token。数据库只保存 SHA-256 哈希；邀请可
限制注册邮箱，并支持过期、使用和撤销状态。

## 验证

```bash
go test ./...
go vet ./...
```

## CPA 薄插件

Compose 会构建 `cliproxyapi-plugin/` 并将动态库放入 CPA 的私有插件目录。
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

插件负责 CPA 凭据选择扩展与用量/失败遥测。计费仍使用 Relay 代理层关联到具体
请求的响应用量，避免 CPA 插件事件缺少自定义关联 ID 时发生串账。
