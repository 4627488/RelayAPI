# Agent Note: Frontend design contract

Status: implemented

## Problem

The console had shadcn/ui and a project skill, but no agent-facing visual contract. Handmade palettes (stock Nova/Geist, then a paper/copper "Relay Desk") and later the official Sera editorial preset still drifted from a dense operator console. Agents kept inventing wrappers on top of the registry.

## Decision

The look is the official shadcn/ui **Mira** preset (`npx shadcn@latest apply mira`): `base-mira`, neutral, Inter, Hugeicons. `DESIGN.md` restates that preset so agents do not invent colors. `AGENTS.md` points UI work at those two files. Login stays a single centered form. Status uses Mira semantic tokens only.

Pages compose official primitives (`Button`, `Item`, `InputGroup`, `Alert`, `Empty`, `Spinner`). Homemade chrome (`PageHeader`, `StatStrip`, `SearchField`, `InfoBar`, `LoadingView`, `LoadErrorView`) is gone.

Do not hand-tune paper, copper, taupe, or a second accent into `web/src/index.css`. To change the look, apply another official named preset.

## Alternatives considered

**Keep Nova/Geist and only add DESIGN.md.** A contract that describes the default still looks like every shadcn dashboard.

**Handmade Relay Desk (paper / copper / IBM Plex).** Faster to type, but the palette was invented in-repo and read as generic "AI taste".

**Sera.** Official, but editorial (Playfair, uppercase square buttons) fights a Chinese operator console.

**Lyra.** Official and more "console", but it wants Phosphor icons and JetBrains Mono as the UI face, which fights Chinese copy.

## Consequences

Future UI changes start from `DESIGN.md`. Changing the look means applying a named preset and updating `DESIGN.md` in the same commit. Prefer official registry components over new wrappers. `npx @google/design.md lint DESIGN.md` checks the contract.
