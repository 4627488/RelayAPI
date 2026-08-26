---
version: alpha
name: Relay Desk
description: Visual contract for the RelayAPI operator console. Agents must follow this file for all UI work.
colors:
  paper: "#F3EFE6"
  surface: "#FAF7F0"
  ink: "#1C211E"
  slate: "#5E675F"
  line: "#D8D1C3"
  primary: "#B4532A"
  primary-foreground: "#FFF8F0"
  secondary: "#E8E2D4"
  secondary-foreground: "#1C211E"
  muted: "#E8E2D4"
  muted-foreground: "#5E675F"
  destructive: "#9B2C2C"
  positive: "#2F6B4F"
  warning: "#A16207"
  dark-paper: "#161814"
  dark-surface: "#1E211C"
  dark-ink: "#EDE7DA"
  dark-line: "#32362F"
  dark-primary: "#D97745"
  dark-primary-foreground: "#1A1612"
typography:
  display:
    fontFamily: IBM Plex Sans
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.02em
  title:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.015em
  body:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.35
  mono:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: -0.01em
    fontFeature: '"zero" 1'
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  page: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: 10px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  sidebar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
---

# Relay Desk

## Overview

RelayAPI is a multi-tenant model gateway. The console is a **dispatch desk**, not a SaaS marketing site and not a generic shadcn dashboard.

It should feel like a paper logbook on an operator's table: warm stock, cool ink, one copper stamp for the next action. Density is higher than a landing page. Hierarchy comes from type size, weight, and space — not from color, badges, or icon tiles.

The audience is the person who already knows what a key, a quota, and a request log are. Do not greet them. Do not sell the product on the login screen. Name the thing on the page.

Chinese is the product language. English appears only in proper nouns (`RelayAPI`, `API Key`, model IDs) and code.

## Colors

The palette is paper, ink, and one copper.

- **Paper (#F3EFE6):** Page and sidebar. Never pure white, never cool zinc.
- **Surface (#FAF7F0):** Cards, inputs, popovers. Slightly lighter than the page so a table sits on the desk, not in a floating glass panel.
- **Ink (#1C211E):** Body text and headings. A green-black, not neutral gray-black.
- **Slate (#5E675F):** Labels, metadata, secondary copy.
- **Line (#D8D1C3):** Hairlines, table rules, input borders.
- **Copper (#B4532A):** The only chromatic color that means "do this". Primary buttons, the wordmark tile, focus rings. One copper object per view.
- **Positive (#2F6B4F) / Warning (#A16207) / Destructive (#9B2C2C):** Status only. Never as decoration or section chrome.

Dark mode inverts the desk: `#161814` paper, `#EDE7DA` ink, brighter copper `#D97745`. Do not invent a second accent for dark mode.

Map these to shadcn tokens in `web/src/index.css`. Use semantic utilities (`bg-background`, `text-primary`, `text-positive`). Never `bg-blue-500`, `text-emerald-600`, or indigo/violet.

## Typography

**IBM Plex Sans** for UI. **IBM Plex Mono** for keys, hashes, model IDs, token counts, and versions. CJK falls back to PingFang SC / Microsoft YaHei — do not load a second display face.

- Page titles: 20px / 600. The shell already names the page; do not repeat a greeting (`你好，…`) or a second H1 that restates the nav label unless the page has no shell chrome.
- Body: 14px / 400 / 1.5.
- Labels and table headers: 12px / 500. Sentence case. No uppercase tracking tricks.
- Mono: 13px, lining tabular numbers, slashed zero when available.

Do not use Geist, Inter, Space Grotesk, or a serif italic for emphasis.

## Layout

Operator density. Default page padding is 24px. Stacks use `flex` + `gap-*` on a 4/8px rhythm. No `space-y-*`.

A typical page is: optional `PageHeader` (title + actions) → one facts strip → the working table or form. Do not wrap that strip in a Card, and do not nest Card in Card.

Login, password change, and other unauthenticated screens are a single centered column (max 28rem). No split marketing panel.

## Elevation & Depth

Flat. Separate regions with hairlines and the paper/surface step. No drop shadows, no glow, no blur, no glass. If a control needs to look raised, use a 1px `line` border, not a shadow.

## Shapes

6px default (`--radius`). Inputs and buttons 6px, cards 8px, avatars may be 6px rounded-lg. Pills (`rounded-full`) only for a true numeric badge count. Do not round the page, the sidebar, or the main stage into a floating inset card more than the shadcn sidebar already requires.

## Components

Use installed shadcn/ui pieces. Compose; do not invent.

- **Buttons:** One copper `default` button per view. Everything else is `outline` or `ghost`. Loading = `Spinner` + `disabled`, never a custom `isLoading` prop.
- **Forms:** `FieldGroup` + `Field` + `FieldLabel`. Validation uses `data-invalid` / `aria-invalid`.
- **Facts:** `StatStrip` / `MetricGrid` — a lined definition list, not icon tiles. Icons in a strip are optional and muted.
- **Tables:** The primary working surface. Mono for identifiers. Status via `Badge` variants or `text-positive` / `text-warning` / `text-destructive`.
- **Empty / Alert / Skeleton:** Use the primitives. No custom pulse boxes or left-border callouts.
- **Brand mark:** The sidebar tile is copper with the Send icon. Never Sparkles, never a gradient orb.

## Do's and Don'ts

- Do read this file and `.agents/skills/shadcn/SKILL.md` before writing UI.
- Do keep copy specific: "创建 API Key", not "开启您的 AI 之旅".
- Don't use indigo→violet, gradient-clip headlines, glass, glow, emoji, or "not just X — it's Y".
- Don't put a marketing slogan or "Powered by …" on login.
- Don't add a second accent, a serif display face, or raw Tailwind palette colors.
- Don't greet the operator or invent dashboard stat rows that the API does not return.
- Don't apply a shadcn `--preset` that overwrites these tokens.
