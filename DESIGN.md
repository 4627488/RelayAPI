---
version: alpha
name: Nova
description: Official shadcn/ui Nova preset, black and white.
colors:
  background: oklch(1 0 0)
  foreground: oklch(0.145 0 0)
  primary: oklch(0.205 0 0)
  muted-foreground: oklch(0.556 0 0)
  border: oklch(0.922 0 0)
typography:
  body:
    fontFamily: Geist
    fontSize: 14px
  heading:
    fontFamily: Geist
    fontWeight: 600
  mono:
    fontFamily: JetBrains Mono
rounded:
  lg: 10px
---

# Nova

RelayAPI 控制台使用官方 **shadcn/ui Nova**，主题是官方 **Neutral（黑白）**。

| 项   | 值                                                                  |
| ---- | ------------------------------------------------------------------- |
| 样式 | `nova`（默认圆角、适中密度）                                        |
| 预设 | `b2fA` / `pnpm exec shadcn apply nova`                              |
| 基础 | Base UI（`base-nova`）                                              |
| 主题 | 官方 Neutral，黑白，没有第二品牌色                                  |
| 字体 | Geist；代码用 JetBrains Mono；中文回退 PingFang / 微软雅黑 / Noto   |
| 图标 | Lucide                                                              |
| 架构 | Vite + React 19 + Tailwind v4 SPA；左侧 Sidebar；`/app` 与 `/admin` |

不要再手调成蓝灰、纸色或铜色。换外观只能再 `apply` 另一个官方具名预设。
