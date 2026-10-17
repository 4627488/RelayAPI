# Agent Note: Default subscription names describe product and share

Status: implemented

## Problem

Child subscriptions inherited upstream account names, sometimes including an email address, or received generic names that did not explain the purchased share. Administrators wanted product names and proportional quantities, with ChatGPT Pro defined as 20X and Claude as 5X for a complete parent allocation.

## Decision

Default new shared names to product plus the per-user share: ChatGPT Pro uses allocation_ppm / 50000 followed by X, Claude uses allocation_ppm / 200000 followed by X, and Grok SuperHeavy uses the exact reduced fraction allocation_ppm / 1000000. Product names come from known provider and plan identifiers, never credential display names or emails. Unknown products use a generic shared-subscription label. Balance grants use the product name followed by 余额付费.

The allocation form derives its default name from the currently selected source and share, including even division, until an administrator edits the name. Explicit names survive subsequent share edits and failed submissions. The store applies the same convention when a shared creation request omits a name, and uses safe product names when canonicalizing balance grants. Existing custom shared names remain editable and are not automatically rewritten during updates or startup.

## Alternatives considered

Always overwriting names when a share changes would discard administrator customization. Copying plan or credential strings directly would reintroduce private identities. Rounding arbitrary Grok shares to familiar denominators would misrepresent allocations such as 333333 ppm, so fractions stay exact. A database-wide startup migration would also rename future administrator-defined subscriptions without authorization; the requested production rename was performed separately with a backup.

## Consequences

Production's 28 existing grants were renamed on 2026-10-16: one ChatGPT Pro 2X, four ChatGPT Pro 5X, four Claude 5X, three Grok SuperHeavy 1/4, one Grok SuperHeavy 1/2, four Antigravity balance grants and eleven Aliyun Bailian balance grants. A transaction verified every field other than name and updated_at remained identical. Name rollback statements are stored on the production host at /opt/relayapi/backups/subscription-names-20261016T003103Z/restore-names.sql. No startup migration is introduced. Store and browser tests cover proportional names, precise small quantities, exact fractions, unknown providers, privacy and preservation of edited names.
