# RelayAPI High-Density Operations Console

## Goal

Redesign both administrator and tenant interfaces as a high-density operations console. Preserve product capabilities while removing low-value presentation, redundant explanation, decorative charts, and repeated summaries. Necessary data must remain easy to scan, compare, and act on.

## Product Principles

- Density comes from useful comparisons, not from placing every value in a card.
- The interface stays visually quiet until something needs attention.
- Every chart answers a specific operational question.
- Tables compare entities; sheets inspect entities; dialogs edit entities.
- Healthy states recede. Errors, quota pressure, and destructive actions receive emphasis.
- Administrator and tenant consoles share a visual system but have different task structures.
- Labels use direct product language. Remove ornamental eyebrow text, snapshot prose, welcome copy, and repeated descriptions.

## Shared Shell

The shell uses a restrained two-column desktop layout and a compact mobile header.

- Left rail: product identity, grouped task navigation, compact counts, session actions.
- Header: current page title, optional operational context, refresh or primary action.
- Main work surface: continuous panels separated by borders rather than nested floating cards.
- Navigation groups are explicit and scannable. The active item uses weight and a narrow accent, not a large filled pill.
- Mobile navigation opens as a sheet. Primary actions remain visible in the page header.
- Remove the permanent `ADMIN` or `TENANT` eyebrow, data snapshot sentence, and broad summary band.

## Administrator Information Architecture

### Monitor

- Overview: request volume, error rate, P95 latency, token throughput, one combined trend, actionable incidents, and routing health.
- Request logs: dense filter bar, compact table, pagination, and right-side request inspection.

### Route

- Credentials, channels, and proxy pool remain distinct views but use the same resource-table grammar.
- Surface health, quota, binding, last activity, and recent failure before configuration detail.

### Access

- Tenants and API keys emphasize owner, status, limits, and last activity.
- Frequent actions remain visible; infrequent row actions move into a menu or detail sheet.

### System

- Settings are grouped by operational effect rather than backend implementation.
- Explanatory text appears only where a choice has a non-obvious consequence.

## Tenant Information Architecture

### Usage

- Overview answers: current consumption, remaining allowance, reliability, and recent change.
- Keep one consumption trend and a compact key comparison.
- Remove decorative cache composition charts and redundant period-detail tables from the default view.

### Access

- API keys are the primary tenant resource. Creation is prominent; editing and revocation stay contextual.

### Connect

- Codex setup becomes a copy-first guided surface with one recommended path.
- Advanced configuration is collapsed until requested.

### Diagnose

- Request logs share the administrator log workbench but use tenant-appropriate columns and language.

### Resources and Settings

- Resources show availability and quota without exposing internal routing complexity.
- Settings remain compact and disclose advanced proxy or User-Agent controls progressively.

## Visual System

- Neutral background and surfaces; one restrained teal accent for selection and focus.
- Semantic status colors are reserved for actual state.
- Use small radii, fine borders, compact row heights, tabular numerals, and consistent alignment.
- Avoid gradients, oversized headings, floating metric-card grids, decorative icons, and excessive badges.
- Default desktop density targets 36–40px control and table-row height while retaining accessible targets on touch layouts.
- Typography uses a clear sans-serif hierarchy and monospace only for identifiers, timestamps, paths, and numeric diagnostics.

## Component Boundaries

- `WorkspaceShell`: grouped navigation, responsive shell, page header, and session actions.
- `MetricStrip`: border-separated values without individual cards.
- `DataPanel`: continuous panel framing for a single data task.
- `SectionToolbar`: predictable search, filters, refresh, and primary action positions.
- `RequestLogsWorkbench`: shared dense diagnostics surface.
- Domain sections own data mapping and actions, but reuse the shared visual grammar.

Large orchestration files should be reduced only where necessary for this redesign. The change must not alter backend contracts.

## Interaction and State

- Loading uses skeletons that preserve table and panel geometry.
- Empty states are short and task-specific, with an action only when one is useful.
- Errors appear near the failed operation and through toast feedback where appropriate.
- Destructive actions require confirmation.
- Filters remain visible while inspecting results; detail sheets do not destroy list state.
- Keyboard focus is visible and navigation remains operable without a pointer.

## Responsive Behavior

- Desktop prioritizes parallel comparison and sticky navigation/toolbars.
- Tablet collapses secondary columns before reducing readability.
- Mobile replaces wide tables with selected essential columns or stacked rows; detail remains in a sheet.
- Charts never force horizontal page scrolling.

## Testing and Acceptance

- Existing behavior tests continue to pass.
- Add focused tests for any extracted presentation logic.
- Run `pnpm test`, `pnpm lint`, and `pnpm build`.
- Verify administrator login, administrator navigation, tenant navigation, log filtering and inspection, key management dialogs, and responsive shell behavior.
- The redesign is successful when the first screen makes current health and next actions obvious, while dense resource pages remain faster to scan than the previous card-based layout.

## Out of Scope

- Backend API contract changes.
- Authentication changes.
- New state-management or visualization libraries.
- Decorative marketing surfaces.
