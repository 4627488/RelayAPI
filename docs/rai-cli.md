# rai 用户 CLI 与设备授权

本轮实现普通用户管理自己的 API Key、订阅额度、用量和授权设备。管理员全站操作不在本轮范围。rai 0.3.0 使用认证契约 2；服务端和 rai 需要一起更新。

## 自动接入

```sh
rai configure codex --server https://relay.example
rai codex
```

首次配置打开浏览器，让用户登录站点并明确批准设备授权。后续 `rai codex` 复用设备会话，无需创建、复制或保存静态 API Key。没有配置时，也可以设置 `RAI_SERVER` 后直接执行 `rai codex`，或复用已有账户管理 profile 的服务器地址进行设备登录。

```sh
rai login --server https://relay.example
rai configure codex
rai codex
rai logout
```

`--no-browser` 只打印授权链接，适用于远程终端；批准操作仍在用户浏览器中完成。`--profile work` 可以区分多个站点。`rai configure codex --server ...` 明确重新授权指定站点；已配置的 profile 不必每次传入地址。

设备授权使用 PKCE S256、一次性交换、15 分钟 access token 和默认 6 个自然月的 refresh 会话。会话期限从批准授权时起计算，刷新不会延长该期限。每次刷新轮换 refresh token；新旧 access token 在各自有效期内可以并存，避免刷新使运行中的客户端缓存立即失效。refresh token 只保存哈希，待交换的凭据在数据库中加密，交换后清除。

Codex 通过 `rai credential print` 定期取得 access token，配置文件只有绑定 profile、rai 目录和服务器地址的 helper 命令。helper 不打开浏览器、不输出 refresh token；会话到期或被撤销后，需要重新运行登录或启动命令。跨进程文件锁串行化刷新，避免多个 helper 同时消耗同一个 refresh token。刷新响应丢失时可能需要重新授权，不会退回静态 Key。

Responses WebSocket 在每个新的 `response.create` 前重新检查 OAuth 授权，已打开的连接不能绕过 token 过期或设备撤销。拒绝后需要客户端重连并取得有效 access token。真实 Codex 长会话的重连与界面行为仍需独立验收，不能仅凭协议与 mock 测试认定所有客户端都能无感恢复。

其他仅支持环境变量凭据的客户端，通过每次启动时创建的 loopback 代理获取持续续期能力。子进程只得到随机的本地临时凭据，代理在每个上游请求前获取有效 access token，客户端退出时关闭。代理只开放 `/v1/` 请求；不提供账户管理能力。

## 自助管理

模型调用和账户管理使用不同的授权用途、独立的凭据存储和 keyring 名称。账户管理也通过浏览器设备授权登录；模型调用凭据不能创建 Key，管理凭据不能直接调用模型。即使账户本身是管理员，管理凭据也不能访问管理员接口。

```sh
rai account login --server https://relay.example
rai account status
rai account quota
rai usage --days 30
rai devices list
rai account logout
```

管理命令返回 JSON。`rai account quota` 查看账户自己的订阅与窗口；原有 `rai quota` 查看当前模型调用凭据授权范围内的额度。账户余额由 `rai account status` 返回。

```sh
rai keys list
rai keys create --name ci --rpm 20 --daily-tokens 100000 --models model-a
rai keys create --name manual-client --show-secret
rai keys update <id> --name new-name --enabled=false
rai keys update <id> --rpm 0 --daily-tokens 0 --models "" --aliases ""
rai keys update <id> --aliases fast=model-a
rai keys delete <id> --yes
rai devices revoke <id> --yes
```

Key 的 `update` 只改变指定选项，保留其余额度、模型限制和别名。`--rpm 0`、`--daily-tokens 0` 清除 Key 级限制，仍受账户限制约束；空模型列表继承账户模型权限。更改模型列表时，别名目标也必须满足新的限制。

只有显式创建的普通 Key 是静态 Key。创建结果默认不含明文；`--show-secret` 显式允许将新 Key 明文写入 stdout，适用于用户自己接入其他客户端。列表、用量、设备和错误输出不包含管理凭据。CLI 不提供读取已有 Key 明文的管理端点。

用户明确希望用静态 Key 接入 rai 时，仍可使用：

```sh
rai login --server https://relay.example --api-key-stdin
```

静态 Key 通过 stdin 输入，不放在命令行参数中。退出此类 profile 只删除本地凭据；需要停用静态 Key 时使用 Key 管理命令。

## 权限与撤销

- 所有自动授权、刷新与管理请求要求 HTTPS，仅允许 loopback 使用 HTTP。本机代理也只监听 loopback，并要求随机凭据。
- 授权链接必须与指定站点同源。携带 OAuth 凭据的客户端请求不跟随重定向，刷新地址绑定原服务器。
- 管理接口使用明确的路由白名单，复用现有用户业务逻辑，以认证用户的 tenant ID 确定范围，不接受调用方指定用户。没有任意 URL、SQL 或管理员 API 透传命令。
- 每次 OAuth 认证检查会话过期、账户启用状态、账户到期、临时密码状态和密码版本。改密、停用或撤销后，后续请求失效。
- 网页的「rai 已登录设备」同时显示模型调用与账户管理用途，可撤销任意自己的授权。退出 OAuth profile 会先撤销服务端 refresh 会话再删除本地凭据；撤销失败会保留凭据供重试。
- 撤销阻止后续请求，不承诺立即中断已经接纳的流式请求。
- refresh token 保存在操作系统 keyring；沿用现有 rai 的受限权限文件后备机制。refresh token 不注入客户端环境变量、启动参数或 Codex 配置。
- OAuth 凭据使用独立命名空间，旧版 rai 的静态 Key 查找路径读取不到新的 token bundle，避免旧 helper 将 refresh token 当作 Key 打印。

旧版浏览器授权生成的长期设备 Key 和手动创建的普通 Key 均继续可用，保留原有期限及停用、撤销规则，不要求现有客户端重新登录。新的浏览器授权只签发可续期的 OAuth 凭据，不再生成长期设备 Key。旧版 rai 发起新的设备登录需要升级；新 rai 对不支持可续期授权的旧服务端会明确报错，不会自动申请长期 Key。

## 验证

`go test ./...` 覆盖命令、helper、刷新锁、凭据隔离和 loopback 代理。设置专用 `TEST_DATABASE_URL` 后，额外验证 PKCE 一次性交换、token 过期与篡改、并发刷新单次消费、跨用户操作拒绝、账户状态变化及服务端撤销。数据库测试应使用隔离实例。

前端验证为类型检查及授权页、设备页浏览器测试，包含管理权限明示和显式批准。
