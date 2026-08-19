# Agent Note: Adopt slim Agent Notes and dsh-find-simplifications

Status: implemented

## Problem

RelayAPI had ad-hoc docs and two imported skills (`kill-ai-slop`, `shadcn`) but no place to record durable design decisions or a repeatable way to hunt unused surface after the external-CPA / plugin era. The DeepSeek Harness `dsh-find-simplifications` skill is the right methodology, but a verbatim copy depends on that repo's `AGENTS.md`, bilingual note triplets, TypeScript format gates, knip, and `dsh-archive-agent-notes`.

## Decision

Port the skill into `.agents/skills/dsh-find-simplifications/SKILL.md` with RelayAPI bindings (docs, `internal/` + `cmd/` + `web/src` corpora, embedded CPA / `relaybridge` as protected seams). Add a slim Agent Note tree under `.agents/notes/` as defined in [README.md](../../README.md): path-encoded lifecycle and class, English only, no generated index, no archive skill, no format verifier.

Use the skill for evidence-backed removals and datastore non-decisions. Implement only candidates that do not change product behavior unless a note records an intentional correctness fix (for example dashboard totals after log compaction).

## Alternatives considered

**Copy the full Harness notes machinery (ZH counterparts, sidecars, `pnpm` gates).** That would add TypeScript tooling this Go/Vite repo does not otherwise need, and an empty archive policy with nothing to archive.

**Write GitHub issues instead of in-tree notes.** Issues leave the repository; they cannot be updated in the same change as the code they justify.

**Skip notes and only delete dead code.** The first survey already includes "do not add ClickHouse / Redis" — those are negative design decisions that will otherwise be re-litigated.

## Consequences

Agents have a local workflow and a place to record why unused plugin client methods, unused `Reserve`/`Settle`, and extra datastores were rejected or removed. Future non-trivial PRs should update or add a note in the same change. The tree starts small; coalescing and archiving wait until there is something to coalesce.
