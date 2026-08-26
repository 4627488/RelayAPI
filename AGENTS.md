# RelayAPI agent notes

This is a Go model gateway with a Vite + React console in `web/`.

## Frontend

For any UI, layout, styling, or copy work:

1. Read [`DESIGN.md`](DESIGN.md) first. It is the visual contract (Relay Desk). Tokens in `web/src/index.css` must stay aligned with it.
2. Follow [`.agents/skills/shadcn/SKILL.md`](.agents/skills/shadcn/SKILL.md). Use installed shadcn/ui components; search the registry before inventing markup.
3. Product copy is Chinese. English is for proper nouns and code only.
4. Do not apply a shadcn `--preset` that overwrites Relay Desk tokens.

If the generated UI looks like default Nova / Geist / indigo SaaS, it is wrong. Re-read `DESIGN.md`.

## Decisions

Non-trivial changes get an Agent Note under `.agents/notes/` — see [`.agents/notes/README.md`](.agents/notes/README.md). Shipped code wins if a note drifts.

Use [`.agents/skills/dsh-find-simplifications/SKILL.md`](.agents/skills/dsh-find-simplifications/SKILL.md) when hunting unused or duplicated surface.

## Backend bounds

Do not reintroduce a loopback HTTP proxy, ClickHouse, or Redis/KV. Native runtime is in-process (`Runtime.Serve`, `DialWebSocket`). Protected seams are listed in the simplifications skill.
