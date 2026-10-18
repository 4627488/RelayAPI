# Cursor 上游

部署 RelayAPI 镜像后，在管理端「模型账户 → 添加账户 → API Key」选择 **Cursor**，
填写名称和 Cursor Dashboard 创建的 `crsr_…` Key。无需接口地址，也无需额外部署服务。
保存时 Relay 自动读取此 Key 的可用模型；在账户「配置」中选择对外发布范围。
租户继续使用本站 `relay_*` Key，不接触 Cursor Key。

## 运行方式

Cursor 的本地 Agent API 依赖 `@cursor/sdk` 和 Node.js。Relay 镜像内置 Node.js 24、
SDK 以及固定版本的 [cursor2response](https://github.com/iFwu/cursor2response)
（`898ffd41b78b2c1a85b5b1c9475517af6fa5834b`，SDK `1.0.31`）。
构建脚本固定 Git 提交并使用上游 lockfile 安装依赖，运行时无需下载网关源码。
SDK 本身可能需要访问 Cursor 的服务和下载端点；部署环境须允许这些出站连接。

Relay 在首次模型发现或推理时启动私有 SDK 子进程，监听随机 loopback 端口，内部桥接使用
随机令牌；Compose 不增加服务或发布端口。使用相同账户代理的凭据共用一组子进程。
子进程退出后，下次访问会重建运行时；删除或停用最后一个使用该代理的 Cursor 账户时回收
对应运行时，Relay 退出时停止所有子进程并清理临时状态。

SDK 进程有独立的内存开销，不计入 Go 的 `GOMEMLIMIT`。启用 Cursor 或配置多种账户代理时，
应相应提高 `RELAY_MEMORY_LIMIT`，并根据实际并发观测容器总内存。

Cursor Key 通过现有凭据加密存储和请求头传递，不写进子进程命令行或默认环境变量。
SDK 子进程不继承数据库密码、服务器密钥或系统代理；输出不进入 Relay 日志。
上游运行时可能在私有临时目录中保存会话及故障诊断，随运行时退出删除；不提供公共 Trace Viewer。

## 协议与会话

推理优先使用 Responses。Relay 的 CPA 层负责将 Chat Completions 和 Messages 转为
Responses，并恢复客户端所需的 JSON 或 SSE 协议；计费、订阅限制、执行追踪和故障冷却
继续使用现有 Relay 链路。模型名称以账户实际返回的目录为准，不维护推测的静态列表。

- 支持 Responses 输入、流式输出、函数工具调用和工具结果回传。
- 客户端应持续发送完整会话历史，包括工具调用、工具结果和 assistant phase。
  `previous_response_id` 不能替代完整历史。
- 使用稳定的 `Session-ID`、`Conversation-ID`、`Thread-ID` 或 `prompt_cache_key`
  保持会话。Relay 将会话标识与本站鉴权主体、上游账户组合后哈希，避免不同租户共享 Agent。
- 工具执行留在客户端，SDK 仅启用 MCP 工具族；不会自动使用 Relay 主机的 shell 或文件工具。
- SDK 的活动 Run 和待回传工具在进程重建后失效；客户端须重新发送完整历史。
- 图片输入使用 base64 data URL；远程图片 URL 不受支持，实际视觉能力取决于模型。
- SDK 桥接请求体上限为 32 MiB，包含完整历史与 base64 图片。
- Responses compact、图像生成、视频和 Realtime 不属于此 Cursor 适配器的能力范围。
  不提供 Cursor OAuth；请使用具有对应模型访问权限的 Cursor API Key。
- Cursor 网关的用量可能是估算值，本站按照网关返回的用量结算，不承诺与 Cursor 账单完全一致。

## 账户代理

选择账户代理后，该代理用于 SDK 到 Cursor 的连接。Relay 到内置运行时的 loopback 请求
始终直连。当前 SDK 运行方式支持 HTTP(S) 代理；SOCKS 代理会明确报错，不会静默改为直连。
未选择代理时直连 Cursor，不继承系统代理。代理认证参数只进入对应 SDK 进程的私有环境。

## 源码开发

普通 Go 开发和非 Cursor 账户不需要 Node SDK。开发 Cursor 功能时，先准备 Node.js 24+
和 Git，然后在仓库根目录运行：

```bash
node scripts/setup-cursor-runtime.mjs
export RELAY_CURSOR_RUNTIME_DIR="$PWD/.cache/cursor-runtime"
go run ./cmd/relayapi
```

PowerShell：

```powershell
node scripts/setup-cursor-runtime.mjs
$env:RELAY_CURSOR_RUNTIME_DIR = (Resolve-Path .cache/cursor-runtime).Path
go run ./cmd/relayapi
```

可用 `RELAY_CURSOR_NODE` 指定 Node 可执行文件的绝对路径。安装脚本拒绝覆盖已有目录；
升级时构建新的目录并更新配置，或重建镜像。不要在生产请求期间执行 npm 安装。

协议参考：[cursor2response](https://github.com/iFwu/cursor2response)、
[Cursor2API](https://github.com/NGLSG/Cursor2API)、
[composer-api](https://github.com/standardagents/composer-api)。
