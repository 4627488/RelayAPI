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
| Claude Code | 原生 Claude 主模型；Haiku、Sonnet、Opus、Fable 按家族映射；临时设置覆盖旧路由 | Anthropic 网关配置；OAuth 经本次启动的 loopback 代理续期 |
| Claude Desktop | 独立第三方推理配置档，Chat、Code、Cowork 共用原生 Claude 模型目录 | 直接 HTTPS 网关；绑定站点、rai 目录和 profile 的凭据助手自动续期 |
| Grok Build | 网关模型目录与同步注册的启动模型；主模型、会话标题/摘要、图片描述、提示建议与搜索模型 | 启动模型通过环境变量取得本次凭据；OAuth 经 loopback 代理续期 |
| OpenCode | 临时配置内容，含上下文、输入/输出上限、工具、图片与推理信息 | 当前启动凭据；OAuth 经 loopback 代理续期 |
| Pi | 临时 provider 扩展，注册授权模型及能力；退出时删除扩展 | 当前启动的 loopback 凭据或明确导入的静态 Key |
| Hermes | 在现有 `config.yaml` 合并独立命名的 custom provider，启动时明确选择 | 可复用的后台 loopback 代理，每次请求读取有效凭据 |
| Prime Agent | 在现有 `models.json` 合并独立 provider，包含模型与能力 | 可复用的后台 loopback 代理，供后台 worker 继续使用 |

Claude Code 未显式指定模型时，优先保留 rai profile 或站点默认的原生 Claude 模型；若默认是其他厂商模型，则从授权目录选择最新可用的 Sonnet，依次回退到 Opus、Haiku、Fable，不修改其他客户端的模型偏好。显式 `--model` 仍可选择 Claude Code 兼容的自定义模型 ID。Desktop 只接受可识别为 Claude 且支持工具的授权模型。

原生 Claude 的 Haiku、Sonnet、Opus、Fable 别名分别选择目录里的对应家族，主模型所在家族保留当前选择；缺少某个家族时回退到主模型。已有的合法 Claude 角色选择会保留，旧的 GPT 角色映射会被替换。用户在 agent 定义中明确指定的子代理模型仍受客户端自己的优先级控制，服务端继续校验实际请求权限。

原生 Claude 使用完整系统提示词、自动工具搜索和客户端默认输出预算，不把目录中的最大输出能力强制设为每次请求的预算。显式用户输出预算仍可使用；配置时会迁移旧 rai 简化提示词配置附带的输出上限。自定义非 Claude 模型仍使用服务端声明的输出上限。`rai claude` 在私有临时文件中传入会话设置，避免旧 `settings.json` 覆盖站点与认证；客户端退出后删除文件。图片描述、搜索等功能仍需上游支持。

Grok 的 npm 包装器在首次启动时可能先检查登录，再完成异步目录加载。`rai grok` 因此会同步注册独立的启动模型条目，凭据使用 `RAI_API_KEY` 环境引用，不写入上游 Key，也不改变原有默认模型。启动条目与 configure 的持久条目分开，可以用 `rai unconfigure grok` 恢复。

Hermes、Pi 和 Prime 的 provider 与认证参数由 rai 管理，透传冲突的 `--provider`、`--api-key` 等选项会报错；更换站点使用 rai profile。Hermes 要求至少 64,000 token 的上下文；已知模型窗口不足时在启动前报错。

服务端 session 可返回可选的 `model_info`，仅包含当前凭据可见 ID 及其能力。别名继承实际目标的资料，管理员覆盖优先；资料本身不授予模型访问权限。明确无工具能力或仅输出图片等非文本内容的模型不进入 agent 目录。旧服务器不返回能力时，OpenCode 保留客户端默认值；Pi/Prime 因配置格式要求采用保守的 32K 上下文和最多 4K 输出。Pi/Prime 的零价格字段表示缺少价格资料，实际费用以 RelayAPI 结算为准。

## 后台代理与配置清理

### 配置后直接使用客户端

`rai configure <agent>` 支持下表中的全部客户端，Codex 与 Claude Desktop 使用凭据助手，其余六个客户端使用可复用的后台代理。配置后可以直接打开 Desktop 或运行 `claude`、`opencode`、`grok`、`pi`、`hermes`、`prime-agent`，不要求先安装客户端二进制才能写入配置。

| 客户端 | 用户级配置位置 | 设置内容 |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json`，默认 `~/.claude/settings.json` | 网关环境、主模型和家族角色；移除冲突的 `apiKeyHelper`，恢复时还原 |
| Claude Desktop | Linux：`$XDG_CONFIG_HOME/Claude-3p/`，默认 `~/.config/Claude-3p/`；macOS：`~/Library/Application Support/Claude-3p/`；Windows：`%LOCALAPPDATA%/Claude-3p/` | `configLibrary` 中的独立 rai 配置档、`_meta.json` 选择与 `claude_desktop_config.json` 的第三方模式 |
| OpenCode | `$OPENCODE_CONFIG`，否则 `$XDG_CONFIG_HOME/opencode/opencode.json[c]`，默认 `~/.config/opencode/` | 独立 provider、模型能力、默认模型与后台小模型；已有 JSONC 文件优先 |
| Grok Build | `$GROK_HOME/config.toml`，默认 `~/.grok/config.toml` | 独立的本地模型条目、主模型与辅助角色；实际请求使用原始模型 ID |
| Pi | `$PI_CODING_AGENT_DIR/models.json` 和 `settings.json`，默认 `~/.pi/agent/` | 独立 provider、完整模型列表、默认 provider/model 和可选推理档位 |
| Hermes | `$HERMES_HOME/config.yaml`，默认 `~/.hermes/config.yaml` | 独立 custom provider、默认模型路由和可选推理档位 |
| Prime Agent | `$PRIME_AGENT_CODING_AGENT_DIR/models.json` 和 `settings.json`，默认 `~/.prime/agent/` | 独立 provider、模型资料、默认 provider/model 和可选推理档位 |

```sh
rai --profile work configure opencode --model model-a --yes
opencode
rai --profile work unconfigure opencode

rai --profile work configure claude-desktop --model claude-sonnet-5-5 --reasoning-effort medium --yes
# 完全退出并重新打开 Claude Desktop，新建 Chat、Code 或 Cowork 会话
rai --profile work unconfigure claude-desktop
```

Claude Desktop 配置遵循其原生第三方推理流程，不使用 Claude Code 的 `settings.json` 环境来接管 Desktop。`CLAUDE_USER_DATA_DIR` 可显式指定 Desktop 数据目录。rai 选择一个独立的配置档，保留其他配置档、界面偏好和原先的选择；模型列表只包含当前授权、支持工具的 Claude ID，按家族标记默认模型。凭据助手缓存 60 秒、超时 30 秒，直接使用网关端点，不依赖 loopback 后台代理；系统重启后无需重新启动 rai 代理。保持 rai 路径稳定，移动二进制或更换 profile 的站点后需要重新 configure。Desktop 不支持 `none` 推理档位，使用 `low/medium/high/xhigh/max`。

Desktop 的配置档、选择元数据和启动模式使用同一套恢复记录；多文件写入失败会回滚。`unconfigure` 移除 rai 加入的配置档条目，保留后来新增的其他条目与用户切换的选择。配置仅作用于本机，既有会话需要重新打开；Cowork 的虚拟化和操作系统依赖仍由 Desktop 检查。此流程基于已确认可用的 Claude Desktop 4.23118.0 配置格式，旧版本未验证。

默认先展示写入路径并确认，`-y/--yes` 跳过交互确认。备份保存为 `.rai.bak`，相邻的 `.rai-*.json` 记录恢复基线。`unconfigure` 可以在没有登录凭据时恢复这些记录；若显式指定 profile，必须与记录的 profile 匹配。未修改的文件精确恢复，后续编辑按字段保留；认证与目的地址作为一组恢复，避免把原有凭据接到用户后来修改的地址上。Pi/Prime 的两份文件写入失败时会回滚。旧版 rai 启动 Hermes/Prime 时生成的 provider 仍可通过原清理路径移除。

这些用户级配置不覆盖客户端自己的企业策略。使用后台代理的配置在系统重启或停止代理后，需要重新执行对应的 configure；不会自动安装系统启动服务。新选择模型、授权目录或能力发生变化时，也可重新 configure。

### 代理生命周期

Hermes 的 gateway 和 Prime 的 worker 可以在前台客户端结束后继续运行，因此使用独立的 rai 代理进程。相同站点 profile 复用同一个端点，只有该用户可读的本地配置保存随机 loopback 凭据。上游 access/refresh token 不写入客户端配置。

```sh
rai --profile work proxy status
rai --profile work proxy stop
rai --profile work unconfigure hermes
rai --profile work unconfigure prime-agent
```

`proxy stop` 会使仍在工作的后台客户端失去本地端点；下次通过 rai 启动会重新创建并更新配置。系统重启后也需要通过 rai 启动以恢复端点。退出 profile 会先撤销 OAuth 会话，再停止代理并删除本地凭据；撤销失败保留原授权供重试。更改 profile 的服务器地址后，旧代理拒绝继续使用该 profile。

通过 configure 建立的配置由恢复记录还原。仅通过旧版启动流程写入的 Hermes/Prime provider，`unconfigure` 保持原有按 profile 清理的行为，需在删除该 profile 前执行。Prime 的 JSON 注释、URL 字符串和其他 provider 会保留；Hermes 通过 YAML 节点保留其他设置及注释。无效配置会明确报错并保留原文件。

`doctor --agent <name>` 检查所选客户端、凭据和 session；失败返回非零退出码。它不会发起付费模型调用，也不代替下面的端到端测试。无参数 `doctor` 保持原有的综合诊断输出。

## 真实客户端验证

测试使用独立 HOME、假凭据和本地 HTTP 上游，验证请求的认证、模型、流式回复，以及实际读取文件工具的执行和结果续接。Prime 使用发行包附带的 Python REPL runtime；只下载二进制无法执行它的工具。Hermes 使用官方 `uv.lock` 安装，包含上游声明的依赖覆盖规则。

本地验证的版本：Pi 1.4.0、OpenCode npm 1.19.4 与 Arch 2.1.3、Grok Build npm 1.0.70 与 Arch 1.0.45、Claude Code 2.1.114 和 2.1.322、Prime Agent 0.10.1、Hermes 源码 `d05095663342556788cf2a198bfa7844cc7968ab`。Claude Code 2.1.322 的真实客户端测试还验证旧用户设置无法覆盖本次网关端点和认证。Desktop 的配置格式来自 Linux 4.23118.0 的可用配置；Windows/macOS 仅验证配置路径和交叉编译，未做 GUI 端到端测试。这些结果不能推广为全部历史版本、所有 UI 或所有商业上游均已通过。

```sh
export RAI_PI_INTEROP_BINARY=/path/to/pi
export RAI_OPENCODE_INTEROP_BINARY=/path/to/opencode
export RAI_GROK_INTEROP_BINARY=/path/to/grok
export RAI_CLAUDE_INTEROP_BINARY=/path/to/claude
export RAI_PRIME_AGENT_INTEROP_BINARY=/path/to/full-prime-package/prime-agent
export RAI_HERMES_INTEROP_BINARY=/path/to/hermes
go test -count=1 -v ./internal/rai -run '^TestAgentClient(UsesGateway|ToolRoundTrip|ConfiguredUsesGateway|ConfiguredToolRoundTrip)$'
```

未配置对应变量时只跳过该客户端。CI 的 `Real rai agent clients` job 固定安装六个官方客户端，既验证 rai 启动流程，也验证实际执行 configure 后不携带模型/凭据参数直接启动客户端的回复和工具往返。所有测试使用隔离配置。Codex 的真实客户端测试沿用原有独立步骤。

普通包测试还覆盖模型资料的授权隔离、配置保留、后台代理进程复用、OAuth 续期、删除凭据后拒绝请求，以及代理只开放推理路径。Codex Desktop/TUI 的界面、WS 到期重连、真实模型的搜索/Fast/压缩质量仍需单独验收，见 [Codex 架构](rai-architecture.md)。
