# Agent Notes

One kind of design doc lives here. An **Agent Note** records a decision or proposal that affects this codebase — the *why* and *what we gave up*, the parts code and docs cannot carry.

This is a slim port of the DeepSeek Harness Agent Note convention. There is no generated index, no Chinese counterpart requirement, no TypeScript format gate, and no archive tree yet.

## Layout and naming

Every Agent Note has two axes, both encoded in its **path** — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the note's status. Move the file when the status changes:
  - **`proposed/`** — reviewed before implementation; not yet built (or only partly).
  - **`implemented/`** — the decision shipped. Keep facts (paths, names, defaults) current with the code.
  - **`rejected/`** — considered and declined. Keep it only while the rationale prevents a tempting mistake; otherwise delete it.
- **Class** (the nested folder) is the kind of decision:

| Class | What it covers |
|---|---|
| `feature` | A new user- or operator-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about shipped source — package boundaries, runtime vocabulary, datastore choices. |
| `process` | Tooling, policy, or workflow around the code. |
| `testing` | Test infrastructure and strategy. |

The date in the filename is when the topic was first proposed. Cross-references use relative Markdown links.

## When to write one

Write or update a note for a non-trivial change: behavior, architecture, a contract shared across files, process, testing strategy, an on-disk / wire / configuration format, or another decision a maintainer may reasonably revisit. Updating the note that already owns the decision is enough; do not duplicate.

A purely mechanical or local edit with no change to behavior, contracts, structure, process, or rationale is exempt.

An implemented note that is fully superseded may be consolidated into the current owner and deleted. Before deletion, move every unique rationale, alternative, consequence, and named coverage gap; repair inbound links. Partial supersession stays cross-linked.

## The file format

The first three lines are exactly:

```markdown
# Agent Note: <title>

Status: <status>
```

followed by a blank line. `Status:` is one of `proposed`, `implemented`, or `rejected — <why, in one line>`, and must match the lifecycle folder.

Keep prose paragraphs on one physical line.

### `proposed/`

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

### `implemented/`

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

### `rejected/`

Keep the proposal-time sections. The verdict lives on the `Status:` line.

### Alternatives considered

Every note records genuine alternatives and why they lost. A decision without what it beat invites re-litigation.

## Finding simplifications

Use [dsh-find-simplifications](../skills/dsh-find-simplifications/SKILL.md) to survey unused or duplicated surface and write evidence-backed notes. Tiny local cleanups may be inline `TODO(tag)` / `FIXME(tag)` / `XXX(tag)` comments instead of a note.
