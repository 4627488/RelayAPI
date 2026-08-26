# RelayAPI agent notes

This is a Go model gateway with a Vite + React console in `web/`.

## Frontend

For any UI, layout, styling, or copy work:

1. Read [`DESIGN.md`](DESIGN.md). The look is the official shadcn/ui **Mira** preset, not a handmade theme.
2. Follow [`.agents/skills/shadcn/SKILL.md`](.agents/skills/shadcn/SKILL.md). Use official installed components; search the registry before inventing markup or wrappers.
3. Product copy is Chinese. English is for proper nouns and code only.
4. Do not invent colors or fonts. If the theme must change, apply another official named preset (`npx shadcn@latest apply <name>`) — do not hand-edit a new palette into `web/src/index.css`.

## Decisions

Non-trivial changes get an Agent Note under `.agents/notes/` — see [`.agents/notes/README.md`](.agents/notes/README.md). Shipped code wins if a note drifts.

Use [`.agents/skills/dsh-find-simplifications/SKILL.md`](.agents/skills/dsh-find-simplifications/SKILL.md) when hunting unused or duplicated surface.

## Backend bounds

Do not reintroduce a loopback HTTP proxy, ClickHouse, or Redis/KV. Native runtime is in-process (`Runtime.Serve`, `DialWebSocket`). Protected seams are listed in the simplifications skill.
