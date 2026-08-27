---
version: alpha
name: Lyra
description: Official shadcn/ui Lyra preset for the RelayAPI console.
colors:
  background: oklch(1 0 0)
  foreground: oklch(0.145 0 0)
  primary: oklch(0.205 0 0)
  muted-foreground: oklch(0.556 0 0)
  border: oklch(0.922 0 0)
typography:
  body:
    fontFamily: JetBrains Mono
    fontSize: 13px
  heading:
    fontFamily: JetBrains Mono
    fontWeight: 600
rounded:
  none: 0px
---

# Lyra

RelayAPI 控制台使用官方 **shadcn/ui Lyra** 预设。

| 项   | 值                                                                             |
| ---- | ------------------------------------------------------------------------------ |
| 样式 | `lyra`（方正、等宽、开发工具密度）                                             |
| 预设 | `buFznsW` / `pnpm exec shadcn apply lyra`                                      |
| 基础 | Base UI（`components.json` 的 `style` 为 `base-lyra`）                         |
| 主题 | 官方 Neutral，黑白，无第二品牌色                                               |
| 字体 | JetBrains Mono；中文回退 Sarasa / Noto / PingFang / 微软雅黑                   |
| 图标 | 原语用 Phosphor；业务页可继续用 Lucide                                         |
| 架构 | Vite + React 19 + Tailwind v4 SPA；左侧 Sidebar；`/app` 与 `/admin` 两套工作区 |

这是给操作员用的模型网关控制台，不是营销站。Lyra 的方正直角、等宽字和中性色就是身份，不要再叠一层自制皮肤。

## 不要做

- 不要手调 `--primary` / `--background` 成蓝灰、纸色、铜色、taupe 或 indigo。
- 不要换成 Inter、Playfair、Geist 或系统 Segoe 当正文。
- 不要再套 Nova / Mira / Sera / Astryx，除非人明确要求换官方具名预设。
- 不要加渐变标题、玻璃、光晕、emoji 或口号。

换外观的唯一方式：`cd web && pnpm exec shadcn apply <named-preset>`。

中文回退只为补齐 CJK 字形，不是另一套主题。状态色 `--positive` / `--warning` / `--info` 只用于用量和日志，不当地品牌强调色。
