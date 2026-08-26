---
version: alpha
name: Sera
description: Official shadcn/ui Sera preset. Do not invent a palette. Agents must follow this file for all UI work.
colors:
  background: oklch(1 0 0)
  foreground: oklch(0.147 0.004 49.3)
  card: oklch(1 0 0)
  primary: oklch(0.214 0.009 43.1)
  primary-foreground: oklch(0.986 0.002 67.8)
  secondary: oklch(0.96 0.002 17.2)
  muted: oklch(0.96 0.002 17.2)
  muted-foreground: oklch(0.547 0.021 43.1)
  border: oklch(0.922 0.005 34.3)
  destructive: oklch(0.577 0.245 27.325)
  dark-background: oklch(0.147 0.004 49.3)
  dark-foreground: oklch(0.986 0.002 67.8)
  dark-primary: oklch(0.922 0.005 34.3)
typography:
  display:
    fontFamily: Playfair Display
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.15
  title:
    fontFamily: Playfair Display
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: Noto Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Noto Sans
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.35
  mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: -0.01em
    fontFeature: '"zero" 1'
rounded:
  none: 0px
  sm: 4px
  md: 6px
  lg: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.none}"
    padding: 16px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
---

# Sera

## Overview

This console uses the official **shadcn/ui Sera** preset (`base-sera`, taupe, Noto Sans, Playfair Display, Lucide). Taste comes from that preset, not from a one-off palette.

Do not invent colors, fonts, or a "brand accent". If the look must change, apply another official preset with the CLI. Do not hand-tune `--background` / `--primary` into paper, copper, indigo, or anything else.

Chinese is the product language. English is for proper nouns (`RelayAPI`, `API Key`, model IDs) and code.

## Colors

Tokens live in `web/src/index.css` and are Sera taupe. Use semantic utilities only: `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-primary`, `text-destructive`.

Status uses `text-foreground`, `text-muted-foreground`, or `text-destructive`. Do not add `emerald-*`, `amber-*`, or custom `--positive` / `--warning` colors.

Dark mode is the Sera dark taupe pair in the same file.

## Typography

- Body: **Noto Sans**. CJK falls back to PingFang SC / Microsoft YaHei.
- Headings: **Playfair Display** for Latin. Chinese headings use the Noto / system fallback. Do not add a second display face.
- Keys, hashes, model IDs, versions: **JetBrains Mono**.
- Sera buttons are small, semibold, uppercase, wide-tracked, square. Do not override that on the `Button` primitive.

Do not switch to Geist, Inter, IBM Plex, or a handmade paper/ink stack.

## Layout

Operator density. Page padding 24px. Stacks use `flex` + `gap-*`. No `space-y-*`.

Typical page: optional `PageHeader` → facts strip → table or form. Do not nest Card in Card.

Login and password-change are a single centered column. No marketing split, no slogan, no Sparkles.

## Elevation & Depth

Use Sera's surfaces and hairlines. No drop shadows, glow, blur, or glass.

## Shapes

Sera owns radius. Primary buttons are square (`rounded-none`). Cards use the preset `--radius`. Do not invent a second radius scale.

## Components

Use installed shadcn/ui pieces. Compose; do not invent.

- One `default` button per view. Other actions are `outline` or `ghost`.
- Forms: `FieldGroup` + `Field` + `FieldLabel`.
- Facts: `StatStrip` / `MetricGrid`.
- Empty / Alert / Skeleton: the primitives.

## Do's and Don'ts

- Do read this file and `.agents/skills/shadcn/SKILL.md` before writing UI.
- Do keep copy specific: "创建 API Key", not "开启您的 AI 之旅".
- Don't invent a palette. Don't "improve" Sera with paper, copper, or a second accent.
- Don't apply a random `--preset` unless a human asked for a named official preset.
- Don't greet the operator or add dashboard stats the API does not return.
- Don't use indigo→violet, gradient-clip headlines, glass, glow, or emoji.
