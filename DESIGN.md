---
version: alpha
name: Mira
description: Official shadcn/ui Mira preset. Do not invent a palette. Agents must follow this file for all UI work.
colors:
  background: oklch(1 0 0)
  foreground: oklch(0.145 0 0)
  card: oklch(1 0 0)
  primary: oklch(0.205 0 0)
  primary-foreground: oklch(0.985 0 0)
  secondary: oklch(0.97 0 0)
  muted: oklch(0.97 0 0)
  muted-foreground: oklch(0.556 0 0)
  border: oklch(0.922 0 0)
  destructive: oklch(0.577 0.245 27.325)
  dark-background: oklch(0.145 0 0)
  dark-foreground: oklch(0.985 0 0)
  dark-primary: oklch(0.922 0 0)
typography:
  display:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.2
  title:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.25
  body:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter
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
  sm: 6px
  md: 10px
  lg: 12px
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
    rounded: "{rounded.sm}"
    padding: 8px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
---

# Mira

## Overview

This console uses the official **shadcn/ui Mira** preset (`base-mira`, neutral, Inter, Hugeicons). Taste comes from that preset, not from a one-off palette.

Do not invent colors, fonts, or a brand accent. If the look must change, apply another official named preset with the CLI. Do not hand-tune `--background` / `--primary` into paper, copper, taupe, indigo, or anything else.

Chinese is the product language. English is for proper nouns (`RelayAPI`, `API Key`, model IDs) and code.

## Colors

Tokens live in `web/src/index.css` and are Mira neutral. Use semantic utilities only: `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-primary`, `text-destructive`.

Status uses `text-foreground`, `text-muted-foreground`, or `text-destructive`. Do not add `emerald-*`, `amber-*`, or custom `--positive` / `--warning` colors.

Dark mode is the Mira dark neutral pair in the same file.

## Typography

- Body and headings: **Inter**. CJK falls back to PingFang SC / Microsoft YaHei.
- Keys, hashes, model IDs, versions: **JetBrains Mono**.
- Mira buttons are compact (`h-7`, `text-xs`). Do not override that on the `Button` primitive.

Do not switch to Geist, Noto Sans, Playfair Display, IBM Plex, or a handmade paper/ink stack.

## Layout

Operator density. Page padding 24px. Stacks use `flex` + `gap-*`. No `space-y-*`.

Typical page: page-title from the shell → optional action row (`flex justify-end` + `Button`) → facts (`Item variant="outline"`) → table or form. Do not nest Card in Card.

Login and password-change are a single centered column. No marketing split, no slogan, no Sparkles.

## Elevation & Depth

Use Mira's surfaces and hairlines. No drop shadows, glow, blur, or glass.

## Shapes

Mira owns radius (`--radius: 0.625rem`). Do not invent a second radius scale.

## Components

Use installed official shadcn/ui pieces from `web/src/components/ui/`. Compose them in the page. Do not invent wrappers (`PageHeader`, `StatStrip`, `SearchField`, `InfoBar`, `LoadingView`, `LoadErrorView`).

- One `default` button per view. Other actions are `outline` or `ghost`.
- Forms: `FieldGroup` + `Field` + `FieldLabel`.
- Search: `InputGroup` + `InputGroupAddon` + `InputGroupInput`.
- Facts: official `Item` (`variant="outline"`) with `ItemContent` / `ItemTitle` / `ItemDescription`.
- Loading: official `Spinner`. Empty / error: official `Empty` + `EmptyHeader` + `EmptyMedia` + `EmptyTitle` + `EmptyDescription` + `EmptyContent`.
- Callouts: official `Alert`.

Official primitives use Hugeicons. Feature pages may keep Lucide until a page is rewritten. Do not invent a third icon set.

## Do's and Don'ts

- Do read this file and `.agents/skills/shadcn/SKILL.md` before writing UI.
- Do keep copy specific: "创建 API Key", not "开启您的 AI 之旅".
- Don't invent a palette. Don't "improve" Mira with paper, copper, taupe, or a second accent.
- Don't apply a random `--preset` unless a human asked for a named official preset.
- Don't greet the operator or add dashboard stats the API does not return.
- Don't use indigo→violet, gradient-clip headlines, glass, glow, or emoji.
- Don't add homemade design-system wrappers when an official component exists.
