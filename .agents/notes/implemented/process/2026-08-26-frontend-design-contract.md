# Agent Note: Frontend design contract

Status: implemented

## Problem

The console already used shadcn/ui Nova (Base UI) and a project skill, but it had no agent-facing visual contract. Tokens were the stock neutral/Geist preset. Login used a marketing split, Sparkles, and a slogan. Agents writing UI therefore defaulted to generic dashboard chrome, and the shipped look stayed "default shadcn".

## Decision

`DESIGN.md` at the repo root is the visual contract (Relay Desk: paper, ink, one copper). `AGENTS.md` points UI work at that file and the shadcn skill. `web/src/index.css` maps the tokens (IBM Plex, 6px radius, copper primary, semantic `positive` / `warning`). Login is a single centered form. Status colors use tokens, not raw emerald/amber. Do not apply a shadcn `--preset` that overwrites these values.

## Alternatives considered

**Keep Nova/Geist and only add DESIGN.md.** A contract that describes the current default would not fix the look, and agents would keep reproducing it.

**Apply a public shadcn preset.** Presets overwrite fonts, radius, and components. We need a product-specific desk, not another named theme.

**Full page rewrite.** The pages already compose shadcn correctly. Token + chrome + contract is enough; the working tables stay.

## Consequences

Future UI changes start from `DESIGN.md`. Changing the look means updating that file and `web/src/index.css` in the same commit. `npx @google/design.md lint DESIGN.md` checks the contract.
