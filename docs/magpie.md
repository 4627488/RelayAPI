# Magpie 接入

在「API 密钥」创建新密钥，或点击已有密钥的「查看」，即可在完整密钥下方点击官方 **Add to magpie** 按钮。支持 Magpie 0.1.8 及更新版本，需在 Magpie 中确认导入。

导入同时配置 Chat Completions、Responses、Anthropic Messages 和 Gemini 原生 API。模型交由 Magpie 从 `/v1/models` 动态发现，因此保留本站密钥的模型权限和别名，不绑定静态厂商目录或估算价格。

## 余额与订阅额度

HTTPS 站点会自动配置 `GET /api/magpie/balance`，使用同一 API Key 认证，无需账户管理令牌。返回 `balance_usd`（本站账户美元余额）和 `subscriptions`（该密钥有权使用的订阅周期）。每个周期返回 `remaining`（0–1）和 `resets_at`；剩余量扣除已结算和预占额度，零额度显示 0。

Magpie 通过 `balance_path` 同时显示美元余额与各订阅周期的剩余百分比。不同周期不能直接相加，订阅额度也不会混入现金余额。仅返回用户分配到的额度，不暴露上游账户、凭据或上游总额度。

订阅路径使用稳定的订阅 ID，不依赖列表顺序。导入后新增订阅或新增周期时，重新点击导入按钮并在 Magpie 确认替换，以更新显示项。已导入周期的数值由 Magpie 后续查询更新；重置时间也由接口返回，但导入协议没有单独的重置时间显示配置。

生产环境请将 `RELAY_PUBLIC_URL` 设置为站点的 HTTPS 公网地址。Magpie 允许本机/内网 HTTP Base URL，但余额地址必须为 HTTPS，因此本地 HTTP 导入省略余额设置。

## 密钥处理

导入接口通过当前登录用户校验密钥归属，只允许有效且可恢复的密钥。导入链接只在点击按钮时生成，密钥置于 `https://usemagpie.ai/import#...` 的片段中；生成结果和余额回复均禁止缓存。官方浅色和深色 SVG 按钮保存在本站静态目录，无需加载第三方脚本。

参考：[Magpie 官方导入协议](https://usemagpie.ai/docs/zh/import)。
