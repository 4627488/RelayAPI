# rai 客户端兼容性

rai 启动本机已有的客户端，使用当前站点 profile 的模型授权和凭据。客户端自己的工作目录、历史、工具权限和项目规则继续生效。缺少客户端时显示对应的官方安装入口。

```sh
rai claude --model model-a
rai codex --model model-a
rai grok --model model-a
rai opencode --model model-a
rai pi --model model-a
rai hermes --model model-a
rai prime-agent --model model-a
rai pi --model model-a --reasoning-effort high -- --print "Explain this project"
rai doctor --agent pi
```

`--reasoning-effort` 支持 `none/minimal/low/medium/high/xhigh/max/ultra`，只作用于本次启动。rai 按客户端原生选项映射；客户端和模型仍决定实际可用的推理档位。Pi 与 Prime 的 `none` 映射为 `off`，`ultra` 映射为 `max`。需要保持客户端原生选项时，放在 `--` 后。模型 ID 始终使用站点目录中的原值；OpenCode 原生 `--model` 可使用 `relayapi/<id>`。

## 适配方式

| 客户端 | 模型与配置 | 凭据与续期 |
| --- | --- | --- |
| Codex | Responses provider、目录、原生 profile 与能力协商 | 绑定站点与 rai 目录的原生凭据助手 |
| Claude Code | 主模型；Haiku、Sonnet、Opus、Fable 别名及默认子代理模型 | Anthropic 网关配置；OAuth 经本次启动的 loopback 代理续期 |
| Grok Build | 网关模型目录；主模型、会话标题/摘要、图片描述、提示建议与搜索模型 | `GROK_MODELS_BASE_URL` 与本次启动凭据；OAuth 经 loopback 代理续期 |
| OpenCode | 临时配置内容，含上下文、输入/输出上限、工具、图片与推理信息 | 当前启动凭据；OAuth 经 loopback 代理续期 |
| Pi | 临时 provider 扩展，注册授权模型及能力；退出时删除扩展 | 当前启动的 loopback 凭据或明确导入的静态 Key |
| Hermes | 在现有 `config.yaml` 合并独立命名的 custom provider，启动时明确选择 | 可复用的后台 loopback 代理，每次请求读取有效凭据 |
| Prime Agent | 在现有 `models.json` 合并独立 provider，包含模型与能力 | 可复用的后台 loopback 代理，供后台 worker 继续使用 |

Claude 已设置的角色模型只有在当前授权目录中仍可用时才保留，否则使用本次主模型。用户在 agent 定义中明确指定的子代理模型仍受客户端自己的优先级控制，服务端继续校验实际请求权限。图片描述、搜索等功能也需要所选模型和上游确实支持对应能力。

Hermes、Pi 和 Prime 的 provider 与认证参数由 rai 管理，透传冲突的 `--provider`、`--api-key` 等选项会报错；更换站点使用 rai profile。Hermes 要求至少 64,000 token 的上下文；已知模型窗口不足时在启动前报错。

服务端 session 可返回可选的 `model_info`，仅包含当前凭据可见 ID 及其能力。别名继承实际目标的资料，管理员覆盖优先；资料本身不授予模型访问权限。明确无工具能力或仅输出图片等非文本内容的模型不进入 agent 目录。旧服务器不返回能力时，OpenCode 保留客户端默认值；Pi/Prime 因配置格式要求采用保守的 32K 上下文和最多 4K 输出。Pi/Prime 的零价格字段表示缺少价格资料，实际费用以 RelayAPI 结算为准。

## 后台代理与配置清理

Hermes 的 gateway 和 Prime 的 worker 可以在前台客户端结束后继续运行，因此使用独立的 rai 代理进程。相同站点 profile 复用同一个端点，只有该用户可读的本地配置保存随机 loopback 凭据。上游 access/refresh token 不写入客户端配置。

```sh
rai --profile work proxy status
rai --profile work proxy stop
rai --profile work unconfigure hermes
rai --profile work unconfigure prime-agent
```

`proxy stop` 会使仍在工作的后台客户端失去本地端点；下次通过 rai 启动会重新创建并更新配置。系统重启后也需要通过 rai 启动以恢复端点。退出 profile 会先撤销 OAuth 会话，再停止代理并删除本地凭据；撤销失败保留原授权供重试。更改 profile 的服务器地址后，旧代理拒绝继续使用该 profile。

`unconfigure` 只删除所选 rai profile 创建的命名 provider，保留其他配置。请在删除该 profile 前执行。Prime 的 JSON 注释、URL 字符串和其他 provider 会保留；Hermes 通过 YAML 节点保留其他设置及注释。无效配置会明确报错并保留原文件。

`doctor --agent <name>` 检查所选客户端、凭据和 session；失败返回非零退出码。它不会发起付费模型调用，也不代替下面的端到端测试。无参数 `doctor` 保持原有的综合诊断输出。

## 真实客户端验证

测试使用独立 HOME、假凭据和本地 HTTP 上游，验证请求的认证、模型、流式回复，以及实际读取文件工具的执行和结果续接。Prime 使用发行包附带的 Python REPL runtime；只下载二进制无法执行它的工具。Hermes 使用官方 `uv.lock` 安装，包含上游声明的依赖覆盖规则。

本地验证的版本：Pi 1.4.0、OpenCode npm 1.19.4 与 Arch 2.1.3、Grok Build npm 1.0.70 与 Arch 1.0.45、Claude Code 2.1.114、Prime Agent 0.10.1、Hermes 源码 `d05095663342556788cf2a198bfa7844cc7968ab`。这些版本的验证结果不能推广为全部历史版本、所有 UI 或所有商业上游均已通过。

```sh
export RAI_PI_INTEROP_BINARY=/path/to/pi
export RAI_OPENCODE_INTEROP_BINARY=/path/to/opencode
export RAI_GROK_INTEROP_BINARY=/path/to/grok
export RAI_CLAUDE_INTEROP_BINARY=/path/to/claude
export RAI_PRIME_AGENT_INTEROP_BINARY=/path/to/full-prime-package/prime-agent
export RAI_HERMES_INTEROP_BINARY=/path/to/hermes
go test -count=1 -v ./internal/rai -run '^TestAgentClient(UsesGateway|ToolRoundTrip)$'
```

未配置对应变量时只跳过该客户端。CI 的 `Real rai agent clients` job 固定安装六个官方客户端并运行两组测试；Codex 的真实客户端测试沿用原有独立步骤。

普通包测试还覆盖模型资料的授权隔离、配置保留、后台代理进程复用、OAuth 续期、删除凭据后拒绝请求，以及代理只开放推理路径。Codex Desktop/TUI 的界面、WS 到期重连、真实模型的搜索/Fast/压缩质量仍需单独验收，见 [Codex 架构](rai-architecture.md)。
