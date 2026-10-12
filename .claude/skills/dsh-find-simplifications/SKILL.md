---
name: dsh-find-simplifications
description: >-
  Use when working in the RelayAPI repo to find non-obvious simplification
  candidates, write proposed or implemented Agent Notes, audit leftover
  external-CPA or plugin surface, or fold worthwhile simplification ideas from
  another PR; especially for dead, duplicated, speculative, over-built,
  added-then-removed, or extra-datastore surfaces (ClickHouse, Redis/KV).
---

# Finding RelayAPI Simplifications

This skill turns a broad "find things to simplify" request into evidence-backed Agent Notes that remove or collapse existing surface area. It is guidance, not a checklist: follow the code, keep judgment active, and prefer a few well-proven candidates over a pile of thin guesses.

The methodology is ported from DeepSeek Harness `dsh-find-simplifications`. Bindings below are for this repo.

## Start With Repo Context

- Read [README.md](../../../README.md), [docs/architecture.md](../../../docs/architecture.md), [docs/subscriptions.md](../../../docs/subscriptions.md), [docs/retention.md](../../../docs/retention.md), and [docs/distribution.md](../../../docs/distribution.md).
- Read the Agent Note rules in [notes/README.md](../../notes/README.md). Treat notes as rationale, not golden truth; shipped code wins when they drift.
- The native runtime is in-process (`Runtime.Serve`, `DialWebSocket`). Do not reintroduce a loopback HTTP proxy.

## Protected Seams (Intentional By Default)

Do not propose deleting these as "low effort" unless the user explicitly overrides the constraint. Removing an unused method *inside* a protected seam can still be valid.

- Parent/child subscriptions and `AdmitRequest` reservation idempotency ([docs/subscriptions.md](../../../docs/subscriptions.md)).
- Public protocol surfaces: `/v1/*`, `/v1/messages`, `/v1beta/*`, Codex compatibility paths.
- Request-log summary vs detail retention; latency trace v3 with v2 UI read compatibility.
- Native quota probes talking to provider endpoints.
- In-process pricing catalog and per-minute rate limiter. Do not introduce Redis/KV or ClickHouse as a simplification; see the datastore note if present under `notes/implemented/architecture/`.

## What Counts As A Strong Candidate

A strong simplification removes, folds, or demotes something real and has clear evidence that the current design costs more than it buys:

- A public method, HTTP path, config knob, helper, package, or test artifact has no production consumer.
- Tests or docs are the only consumers, and the behavior they pin is not load-bearing.
- Two representations mirror the same fact (legacy external-CPA identity vs native credential ID; plugin quota vs `ProbeQuota`).
- A seam has methods every caller must know but no production path uses (`ManagementRaw`, plugin `QuotaReady`).
- Speculative product generality: extra datastores, live registry invalidation, unused dual billing helpers.
- An invariant, rollback path, or special-case test exists only to protect an unused API.
- The simplified behavior may differ slightly, but the new behavior is still reasonable and easier to explain.

Thin candidates are usually not enough for an Agent Note: deleting one typo, removing an intentionally documented backend, or flagging "this looks complex" without call-site proof.

## Survey Broadly

Use parallel subagents when the user asks for breadth. Give each agent a domain and require evidence, not guesses. Useful domains:

- Native runtime and admission: `internal/upstream`, `internal/gateway/admission.go`, `internal/app/proxy.go`, `native_websocket.go`.
- Quota observation: `internal/gateway/native_quota.go` and `internal/app/quota_sync.go`.
- Subscriptions and billing: `internal/store/subscriptions.go`, `store.go` Reserve/Settle vs Admit/SettleRequestReservation, `internal/app/subscriptions.go`.
- Credentials, proxies, runtime settings: `internal/app/providers.go`, `proxies.go`, `native_settings.go`, `internal/cpaimport`.
- Pricing and request logs: `internal/pricing/*`, `internal/store/pricing_backfill.go`, `request_logging.go`, `request_trace.go`, `QueryLogs` / Dashboard / UsageReport.
- Admin/user HTTP API vs `web/src` consumers.
- Docs vs shipped defaults (`architecture.md` frontend claim, README vs `internal/config/config.go`).

If subagents are unavailable, simulate the same breadth yourself. Do not let the first good candidate stop the survey.

Start with the largest production-code deltas. A broad audit that stops after obvious unused symbols can miss duplicated lifecycle or defensive machinery.

## Audit Trust And Lifecycle Boundaries

For every defensive copy, freeze, validator, and callback capture, name where the value came from and who owns it next. Same-process typed service calls ordinarily borrow values; parsers, config loaders, durable files, and wire decoders own or validate their data.

For complex asynchronous code, draw the ownership graph and map each sentinel, readiness promise, cancellation path, disposer, and state flag to a distinct owner. When several mechanisms mirror the same liveness or settlement fact, propose one transaction or lifecycle controller instead. Preserve separate machinery where it protects first-terminal-outcome arbitration, worker/process ownership, or dispose-to-quiescence.

Balance reservation, child-quota windows, and request-log writes are one Postgres transaction story. Do not "simplify" them into a cache or a second database.

## Prove Or Reject Each Candidate

For every symbol or behavior, classify consumers before writing:

- Production corpus: `cmd/`, `internal/` (non-`*_test.go`), Compose/runtime scripts, `.env.example`.
- Non-production corpus: tests, README/docs, Agent Notes, comments.
- Ambiguous corpus: `web/src` (product UI), `internal/cpaimport` (startup import if env is set). Inspect usage before classifying.

Use `rg` first. Good searches include the exact symbol, HTTP path, config key, method name with both `.Name(` and `Name(`, and any wire strings. Then read the call sites. `go vet` unused exports are not a substitute for understanding public methods, dynamic paths, tests, and docs.

Reject or downgrade a candidate when:

- A production caller exists and the simplification would be a feature decision rather than a cleanup.
- The API is explicitly justified by an implemented Agent Note or a hard-won defensive pattern, and the new evidence does not beat that reason.
- The removal would force unrelated churn without actually reducing the public API or required behavior.
- The idea is correct but tiny. Add a targeted `TODO(tag)` / `FIXME(tag)` / `XXX(tag)` instead.

## Write The Agent Note

Create one file per durable proposal under `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`, following [notes/README.md](../../notes/README.md). Keep prose paragraphs on one physical line and use relative Markdown links.

Prefer this structure, adjusting when the idea needs it:

- `# Agent Note: <action-oriented title>`
- `Status: proposed` (or `implemented` when shipping in the same change)
- `## Problem`: name the current API, cite the relevant files, and state the consumer evidence. Separate production callers from tests/docs.
- `## Proposal` or `## Decision`: say exactly what to remove, fold, demote, or rehome. Include tests and docs cleanup.
- `## Alternatives considered`
- `## Why not keep it?` / `## What we give up` / `## Consequences`
- `## Acceptance criteria` (proposed) and `## Risks`

Be concrete enough that an implementing PR can follow the trail. When a proposal overlaps an existing Agent Note, consolidate into the existing one.

## Inline TODO Notes

Use inline TODO/FIXME/XXX only for small, local cleanups that are clearly useful but not durable design decisions:

- Name the smell with a stable tag, e.g. `TODO(double-default)` or `XXX(unused-default)`.
- Explain why it is safe to revisit and what action would simplify it.
- Do not add TODOs for speculative complaints or for behavior that needs an Agent Note-level decision.

## When Folding Another PR Or Branch

Diff the sibling branch against `origin/master` (or `origin/main`), not against the current PR branch. Port non-overlapping notes that meet the quality bar. Do not port duplicate or lower-confidence proposals just to preserve the count.

## Validation And PR Hygiene

For docs-only Agent Note work, run `git diff --check`. If Go comments, TODOs, or code change, also run `gofmt -l ./cmd ./internal`, `go vet ./...`, and `go test -count=1` on the touched packages (`./internal/cpa`, `./internal/store`, `./internal/app` as applicable).

When opening or updating a PR, summarize:

- How many Agent Notes and inline notes were added, consolidated, or deleted.
- The main areas surveyed.
- What was intentionally excluded.
- Which checks passed.

Use a draft PR while the survey is still expanding; mark ready only when the candidate set, review responses, and validation are settled.
