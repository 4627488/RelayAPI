# 用 Magpie 连接 RelayAPI

RelayAPI 只提供 Codex Responses。需要 Chat Completions、Anthropic Messages 或其他客户端格式时，在自己的电脑安装 [Magpie](https://usemagpie.ai)，由 Magpie 转为 Responses 后访问 RelayAPI。

## 导入与检查

1. 在 RelayAPI 的「API 密钥」页面创建或选择一把启用的密钥，点击「连接 Magpie」。
2. 在弹出的配置窗口点击「导入到 Magpie」，在 Magpie 中确认添加。服务商名称包含站点和密钥名称；更新同一密钥的配置会使用稳定的服务商 ID。
3. 复制窗口中的「Magpie 配置命令」命令，在本机终端运行一次。导入链接不接受这些高级选项，因此仅点击导入不会自动开启它们。
4. 在 Magpie 中选择该服务商的模型，再由 Magpie 配置 Codex 等客户端连接到本机服务。

配置窗口保留在 RelayAPI 页面中，并提供安装入口、Responses Base URL 和密钥复制。如果浏览器没有打开 Magpie，可在 Magpie 中手工添加自定义 Responses 服务商，填写复制的 Base URL 和密钥；不需要配置 Chat 或 Messages 上游地址。手工添加时，额度查询 URL 为站点地址加 `/v1/usage`，使用相同密钥作 Bearer 认证；余额表达式为：

```text
可用现金: $ balance_usd; 订阅: subscription_summary
```

「检查配置」验证密钥、模型目录和额度接口，不发送生成请求。「运行生成测试（计费）」会向所选模型发送一条很短的请求，经过正常的权限、限额、预留、调用记录和结算流程。测试结果包含请求 ID，可在「调用记录」核对。关闭窗口会取消正在进行的检查；已经生成的用量仍按正常规则处理。

这是服务端接口检查。公网 DNS、TLS、反向代理和本机网络还需通过 Magpie 发起实际请求验证。

## 原生压缩与 WebSocket

接入窗口根据导入时站点的 WebSocket 设置生成实际服务商 ID 对应的命令，例如：

```sh
magpie provider set relayapi-relay-example-key-id compaction=native socket=auto billing=plan
```

请复制窗口中的真实命令，示例 ID 不能直接使用。命令不含密钥，可重复运行；已有服务商也需要运行一次。手工添加的服务商请替换成 Magpie 实际保存的 ID。

- `compaction=native`：让 Codex 的 `compaction_trigger` 和上游的加密 `compaction` 原样往返，使用 Codex 原生远程压缩。不会改用 Magpie 自己生成的文本摘要。当前 Magpie 对第三方模型使用这条新版 Responses 路径；不要把客户端的 `/v1/responses/compact` 指向 Magpie。RelayAPI 自身仍兼容 `POST /v1/responses/compact`。
- `socket=auto`：Magpie 优先通过 Responses WebSocket 发送流式请求。握手被拒绝等可回退的情况由 Magpie 改用 HTTP；不强制 `socket=on`。站点关闭 WebSocket 时，窗口生成 `socket=off`；已有客户端握手收到 426，可以使用 HTTP。
- 模型目录保持自动发现，保留上下文、输出上限、图片输入和推理档位。Magpie 默认传递客户端 User-Agent，保持这个默认值即可；不强制改成 Magpie 的身份。

原生压缩结果由生成它的账户加密。RelayAPI 在 PostgreSQL 保存「租户、压缩内容摘要、上游账户」路由，先持久化再把压缩结果交给客户端；不修改密文，也不在路由表中保存对话或原始密文。重启、订阅优先级变化和 HTTP/WebSocket 切换后仍回到原账户，并重新执行权限与额度检查。路由保留至最后一次使用后 90 天，过期自动清理。未知或过期的压缩结果返回 400；原账户不再有可用授权时返回 409，不会切换到无法解密的其他账户。此时需要恢复原订阅或开始新对话。

WebSocket 使用真实上游预热响应，支持 `generate:false`、`previous_response_id`、工具调用结果和同一账户内的模型切换。每轮开始前重新检查密钥、模型、限流、订阅和剩余额度；终态用量逐轮记录和结算。已开启的一轮可完成，但停用密钥或撤回订阅后不能继续发起新一轮。订阅额度窗口发生换代时返回带 HTTP 状态的 `websocket_reconnect_required`，允许客户端重新连接并重试完整输入，重新完成该窗口的预留；旧连接不能沿用旧窗口的预留。

## 模型与费用

模型列表按当前密钥权限实时发现，不固化在导入链接中。目录同时提供已知的上下文、输出上限、图片输入、推理档位与默认价格。模型别名继承实际路由模型的能力与价格，未知信息保持缺省。

Magpie 可用目录中的站点价格估算普通文本 token 费用。凭据、服务档位、推理规则、图片输入等请求相关价格，以及上游实际返回模型，可能影响最终费用；以 RelayAPI 调用记录中的结算为准。

调用详情中，未缓存输入、缓存读取、缓存写入和输出分别列出。推理 token 已包含在输出中，不再额外收费。显示的生效单价已经包含倍率。

## 余额与订阅

RelayAPI 采用 Magpie 内置的 sub2api 用量查询兼容方式，保持自定义 Responses 服务商身份，无需选择其他厂商品牌。新导入链接显式配置 `GET /v1/usage` 和上面的余额表达式；旧 `/api/magpie/balance` 地址继续可用。两者使用同一份实时数据，均以当前 API Key 鉴权。

当一份订阅覆盖这把密钥可访问的全部模型，并且每个窗口都有可信额度及未来重置时间时，接口返回原生 `rate_limits`。Magpie 识别其中的 `5h`、`1d`、`7d`，分别展示 USD 上限、已占用额度、剩余比例及重置时间；`used` 包含已结算用量和处理中预留，超额支出保留真实值，`remaining` 最低为零。纯现金入口返回 `mode=unrestricted`，`balance` 和 `remaining` 均为可用现金。套餐没有可相加的总余额，因此不会把现金作为套餐的 `remaining`。

多份订阅、不同模型的额度、未知/零额度、过期观测、暂不可用订阅、不受支持的窗口，以及到期时间早于或等于窗口重置的套餐，均保留完整摘要，不输出会误导整把密钥路由的原生窗口。`quota_mapping` 给出当前映射状态及降级原因；不会把多个套餐或窗口相加，也不会伪造重置时间。

配置命令根据当前模型权限标记 `billing=plan`（纯套餐）、`billing=payg`（纯现金）或 `billing=auto`（混合）。这是 Magpie 的显示分类，不改变 RelayAPI 的结算规则。计费类型变化后可重新打开连接窗口，运行新的配置命令；余额、订阅及窗口本身在后续查询时自动更新。

Magpie 可以按原生额度选择更有余量的线路。它默认仍可能尝试用户明确指定的已耗尽线路；RelayAPI 返回正常的 `429 subscription_quota_exhausted`，Magpie 据此按窗口休息该密钥，而不是把它当作现金不足或每分钟限流。兼容层不会新增套餐耗尽后转现金的规则，实际采用站点既有的订阅与准入规则。客户端缓存及路由仅帮助选择，服务端准入与结算始终生效。

可用现金已经扣除正在处理请求的现金预留。它与订阅窗口是独立限制，不能把订阅比例折算后加到现金中。

Magpie 的订阅摘要在每次额度刷新时重新生成，包含当前密钥适用的订阅、模型范围、各窗口剩余比例、UTC 重置时间和订阅有效期。订阅到期后的窗口重置不会显示为可用的下一次恢复。新增或移除订阅无需重新导入；不同模型、不同窗口的额度不会相加。窗口剩余比例同时扣除已结算用量和正在处理的预留。

- 「按现金余额计费」表示该访问授权没有订阅额度表，不代表免费或无限余额。
- 「额度未知」或「等待额度观测」表示缺少可信额度，不显示成零余额。
- 「等待刷新」表示观测窗口已过期，不能把旧窗口当成已重置的新额度。
- 「暂时不可用」表示订阅仍存在，但当前不能使用。

摘要显示的是额度状态，不保证任意大小的下一次请求都能准入；请求预留、现金余额、密钥限额和实时账号状态仍需通过调用时检查。

Magpie 的导入协议要求自动余额查询使用 HTTPS，并与 Responses 端点位于同一主机。HTTP 本机部署可以导入并调用 Responses，但导入链接不会启用自动查额度。

## 常见失败

| 情况 | 行为 |
| --- | --- |
| 密钥无效或已停用 | 401，检查 RelayAPI 密钥 |
| 现金不足 | 402，补充可用余额 |
| 订阅窗口耗尽 | 429，等待额度恢复；不会当作现金不足 |
| 短期限流或并发拥塞 | 返回可用的等待提示，客户端应遵守 `Retry-After` |
| 上游账号认证失败 | 502，标记上游来源；不会把有效的 RelayAPI 密钥误报为失效 |
| 压缩上下文未知或过期 | 400，开始新对话 |
| 压缩的原账户不再可用 | 409，恢复原订阅或开始新对话 |
| WebSocket 已关闭 | 握手返回 426，改用 HTTP Responses |
| 客户端取消 | 取消上游处理，按实际可确认的终态用量完成结算或释放预留 |

生产反向代理应允许长时间 SSE 响应、及时转发事件，并支持 Responses WebSocket 升级。接口自检成功并不能证明代理没有缓冲流式内容。

## 站点配置与已有导入

生产环境将 `RELAY_PUBLIC_URL` 设置为用户实际访问的 HTTPS 公网地址。升级前已经导入的服务商需要重新导入一次，以启用 `/v1/usage` 原生窗口解析；以后新增或移除订阅无需再次导入。旧查询地址仍能读取余额及摘要，但不会触发 Magpie 的 sub2api 原生窗口识别。

配置接口只允许当前登录用户读取自己有效且可恢复的密钥。导入链接的密钥放在 `https://usemagpie.ai/import#...` 的 URL 片段中，配置和额度响应均禁止缓存。接入窗口不加载第三方脚本。额度只展示当前用户的分配，不披露上游账号、凭据或上游总额度。

参考：[Magpie 官方导入协议](https://usemagpie.ai/docs/zh/import)、[Magpie 服务商配置定义](https://github.com/yetone/magpie/blob/main/internal/provider/provider.go)、[原生压缩实现](https://github.com/yetone/magpie/blob/main/internal/provider/native_compaction.go)、[WebSocket 配置实现](https://github.com/yetone/magpie/blob/main/internal/provider/socket.go)。
