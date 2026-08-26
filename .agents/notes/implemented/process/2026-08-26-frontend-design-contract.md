# Agent Note: Frontend design contract

Status: implemented

## Problem

The console had shadcn/ui and a project skill, but no agent-facing visual contract. Handmade palettes (stock Nova/Geist, then a paper/copper "Relay Desk") drifted with whoever wrote the CSS. Agents kept inventing taste.

## Decision

The look is the official shadcn/ui **Sera** preset (`npx shadcn@latest apply sera`): `base-sera`, taupe, Noto Sans, Playfair Display, Lucide. `DESIGN.md` restates that preset so agents do not invent colors. `AGENTS.md` points UI work at those two files. Login stays a single centered form. Status uses Sera semantic tokens only.

Do not hand-tune paper, copper, or a second accent into `web/src/index.css`. To change the look, apply another official named preset.

## Alternatives considered

**Keep Nova/Geist and only add DESIGN.md.** A contract that describes the default still looks like every shadcn dashboard.

**Handmade Relay Desk (paper / copper / IBM Plex).** Faster to type, but the palette was invented in-repo and read as generic "AI taste".

**Lyra.** Official and more "console", but it wants Phosphor icons and JetBrains Mono as the UI face, which fights Chinese copy. Sera keeps Lucide and uses Noto Sans.

## Consequences

Future UI changes start from `DESIGN.md`. Changing the look means applying a named preset and updating `DESIGN.md` in the same commit. `npx @google/design.md lint DESIGN.md` checks the contract.
