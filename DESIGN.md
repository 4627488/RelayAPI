---
version: alpha
name: Kumo
description: Cloudflare Kumo console for RelayAPI.
colors:
  background: kumo-canvas
  foreground: kumo-default
  primary: kumo-brand
  muted-foreground: kumo-subtle
typography:
  body:
    fontSize: 14px
---

# Kumo

RelayAPI 控制台使用 **Cloudflare Kumo**（`@cloudflare/kumo`），按 `/api` 契约组织页面。

| 项   | 值                                                                  |
| ---- | ------------------------------------------------------------------- |
| 样式 | Kumo                                                                |
| 基础 | Base UI（由 Kumo 提供）                                             |
| 主题 | `data-mode="light\|dark"`，语义色 `bg-kumo-*` / `text-kumo-*`       |
| 图标 | Phosphor                                                            |
| 架构 | Vite + React 19 + Tailwind v4 SPA；Kumo Sidebar；`/app` 与 `/admin` |

不要再引入 shadcn 预设或手调第二套调色板。产品文案用中文，专有名词和代码保持英文。
