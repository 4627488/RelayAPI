# Token 消耗热力图

用户总览展示最近 365 个 UTC 日历日（含今天）的全部模型 token 消耗。
日总量使用 `total_tokens`，不再另加缓存、推理等已包含在总量内的分类。
每天颜色代表当天 token 消耗最多的模型，并列时按模型名称排序选取；深浅按活跃日的四分位数分级。
图例列出全年 token 用量最多的六个模型，其余模型统一为灰色，每日详情仍显示实际模型名称。
配色采用 [ColorBrewer Dark2](https://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8)，提供明暗主题。

近期请求日志与历史日汇总通过同一条 SQL 的 `UNION ALL` 聚合，避免日志归档期间漏计或重复计算。
日汇总归档也使用 UTC；部署前已按非 UTC 数据库时区生成的历史汇总无法还原到 UTC，仍按原日期展示。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/usage/heatmap` | 当前登录用户的日历数据、图例与分享路径 |
| GET | `/api/usage/heatmap.svg` | 当前登录用户的 SVG，无需开启分享 |
| POST | `/api/usage/heatmap/share` | 开启或重置分享，返回新的 `share_path` |
| DELETE | `/api/usage/heatmap/share` | 关闭分享，返回 204 |
| GET | `/share/usage/{token}/heatmap.svg` | 无需登录的公开 SVG |

两个 SVG 接口接受 `?theme=light`、`?theme=dark`、`?theme=auto`（默认）。
用户可在总览复制完整链接或 Markdown，嵌入 GitHub README、博客等页面。

## 分享与隐私

每个用户默认关闭分享。主动开启后生成独立的 256 位密码学随机 token；它不是 API Key、Key 哈希、Key 前缀或用户 ID，也不能用于推理接口或登录。
该字段不参与用户 JSON 序列化，仅通过当前用户的热力图接口返回分享路径。
公开内容仅含日期、每日 token 总量、当天主要模型、汇总与模型颜色图例，不含用户名、邮箱、Key 标识、费用或请求内容。

公开请求始终检查链接是否有效及用户是否启用。重置、关闭分享后，旧链接立即在本站返回 404。
接口设置 `no-store`、`no-referrer`、`nosniff` 与 SVG CSP sandbox，模型文字经 XML 转义，SVG 无脚本、外部资源或跳转。
公开读取限制每个来源 IP 每分钟 120 次，查询最多执行 5 秒；浏览器的跨站分享修改请求会被拒绝。
已经下载的图片以及第三方不遵守缓存策略所保留的副本无法远程撤回。

数据库启动迁移在 `tenants` 增加可空、唯一索引的 `heatmap_share_token`，不新增统计服务或外部存储。
