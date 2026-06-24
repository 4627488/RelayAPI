# RelayAPI Frontend Workbench Redesign

## Goal

Fully replace the current presentation-heavy dashboard style with a concise technical workbench for operators and developers. The new frontend must prioritize scanning, filtering, editing, diagnostics, and repeated operational actions.

## Current Problems

- The previous main consoles were large client components that mixed navigation, state orchestration, charts, settings, formatting, and section rendering.
- The previous visual language was closer to a broad dashboard than an operator workbench: large headers, many cards, long descriptions, and repeated explanatory copy.
- Admin and tenant request log views duplicate substantial code.
- Formatting helpers and table/detail patterns are repeated across section files.
- Important operational domains are separated by implementation history instead of workflow: credentials, channels, and proxy pool should read as one routing workspace; tenants and API keys should read as one access workspace.

## Product Direction

The frontend becomes a technical workbench:

- Dense but readable.
- Minimal descriptive text.
- Clear current state.
- Fast access to common operations.
- Tables, toolbars, status badges, detail drawers, and compact metric strips over decorative cards.
- Shared interaction patterns across admin and tenant consoles.

## Information Architecture

### Admin Console

- Overview: health, traffic, success rate, latency, tokens, compact trend charts.
- Traffic: request logs, status filters, search, pagination, detail drawer, retention cleanup.
- Routing: Codex credentials, channels, proxy pool, quota, reset credits, routing controls.
- Access: admin API keys, tenants, invites, ownership transfer, limits.
- Settings: global proxy, User-Agent, logging policy, retention, automation flags.

### Tenant Console

- Overview: tenant usage, daily limits, success rate, latency, token mix.
- Keys: tenant API key management.
- Setup: direct Codex client configuration with copy-first controls.
- Traffic: tenant-scoped request logs with the same shared log workbench.
- Resources: available channels, credentials, quota visibility, model access.
- Settings: tenant proxy and User-Agent controls when allowed.

## Layout Design

Desktop:

- Left rail navigation with short labels, icons, counts, and status only.
- Top command bar with workspace title, status, snapshot time, refresh, logout, and primary action.
- Main content as a work surface:
  - metric strips for summary state,
  - dense data panels for lists and charts,
  - tables as the primary data display,
  - side sheets for detail inspection.

Mobile:

- Top navigation compresses into a sheet or wrapped segmented control.
- Tables collapse into compact stacked rows where needed.
- Primary actions remain reachable from the top command bar.

## Component Architecture

Shared workbench components:

- `components/workspace/workspace-shell.tsx`: page shell, left rail, command bar, summary region, responsive layout.
- `components/workspace/section-toolbar.tsx`: search, filters, refresh, secondary actions.
- `components/workspace/data-panel.tsx`: compact panel wrapper for tables, metrics, and charts.
- `components/workspace/detail-sheet.tsx`: shared detail drawer wrapper.
- `components/workspace/status-badge.tsx`: status mapping for enabled, disabled, healthy, degraded, error, warning, cooldown, unknown.
- `components/workspace/metric-strip.tsx`: compact horizontal metrics.
- `components/workspace/format.tsx`: shared date, number, token, duration, percent, nullable formatting.
- `components/workspace/api-key-form.tsx`: shared API key form state and field mapping.
- `components/workspace/limit-line.tsx`: shared compact quota line.

Top-level workbench files:

- `components/admin-workbench.tsx`: admin console orchestration.
- `components/tenant-workbench.tsx`: tenant console orchestration.

Shared cross-domain features:

- `components/workspace/request-logs-workbench.tsx`: shared admin/tenant request log list and detail behavior.
- `components/workspace/api-key-form.tsx`: shared key editor fields and conversion helpers.

## Data Flow

- Keep existing Route Handlers and client API helpers.
- Do not introduce a new client state library.
- Page files remain Server Components that provide initial data and auth redirects.
- Client boundaries should be limited to interactive workbench islands.
- Lazy section loading can remain where it improves initial render cost, but the loading state must be visually consistent.

## Interaction Rules

- Do not add marketing-style hero sections.
- Do not add long descriptions in panels.
- Use short labels and machine-readable state.
- Use badges for status, not colored prose.
- Use `Sheet` for inspection and `Dialog` for create/edit/confirm flows.
- Destructive actions require confirmation.
- Toolbars must keep search, filter, refresh, and primary action in predictable positions.
- Tables must support empty and loading states.
- Copy-focused setup controls should show copy buttons near the exact value.

## Visual Rules

- Use the existing shadcn base components and semantic tokens.
- Avoid decorative gradients, large rounded cards, and large typographic headers.
- Keep radii modest and consistent with the existing component system.
- Prefer borders, separators, muted backgrounds, compact spacing, and tabular numbers.
- Avoid one-note color palettes; use neutral base with semantic status accents.
- Keep text inside controls short enough for mobile and desktop.

## Testing And Verification

- `pnpm lint` must pass.
- `pnpm build` must pass.
- Manual smoke check:
  - admin login page still renders,
  - admin workbench renders after auth,
  - tenant workbench renders after tenant session,
  - navigation changes sections,
  - request log workbench can search/filter/page,
  - dialogs and sheets open without layout breakage.

## Out Of Scope

- Changing backend API contracts.
- Adding a new UI library.
- Replacing authentication.
- Changing public `/v1/*` relay endpoints.
- Introducing route-level URLs for every section in the first implementation pass.
