# Codex Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Codex long-session quality by adding upstream error classification, reasoning replay cache, and reusable WebSocket sessions.

**Architecture:** Add focused Codex modules for error parsing, replay state, and WebSocket session reuse, then integrate them into the existing relay path. Keep route handlers thin and test pure behavior with Vitest.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Web Streams, `ws`, Vitest.

---

## File Structure

- Create `vitest.config.mts`: test runner config using TS path aliases.
- Modify `package.json`: add `test` script and Vitest dev dependencies.
- Create `src/server/codex/errors.ts`: classify Codex HTTP/SSE/WS errors and parse retry hints.
- Create `src/server/codex/reasoningReplay.ts`: session-key extraction, bounded in-memory replay cache, request injection, response capture.
- Create `src/server/codex/websocketSession.ts`: reusable upstream WebSocket session manager with injectable socket factory.
- Modify `src/server/codex/client.ts`: apply replay before upstream calls and expose response capture helpers.
- Modify `src/server/codex/websocket.ts`: delegate reusable-session path when a session key exists.
- Modify `src/server/http/relay.ts`: classify stream/non-stream failures, clear replay on invalid encrypted content, write real cooldown timing.
- Modify `src/server/services/channels.ts`: accept explicit retry-after cooldowns.
- Add tests under `src/server/codex/*.test.ts` and `src/server/services/channels.test.ts`.

## Tasks

### Task 1: Test Runner

**Files:**
- Create: `vitest.config.mts`
- Modify: `package.json`

- [ ] Install test dependencies: `pnpm add -D vitest vite-tsconfig-paths`
- [ ] Add `"test": "vitest run"` to `package.json`.
- [ ] Create `vitest.config.mts` with Node environment and `vite-tsconfig-paths`.
- [ ] Run `pnpm test -- --runInBand`; expected: exits with no tests or reports no test files.

### Task 2: Codex Error Classification

**Files:**
- Create: `src/server/codex/errors.ts`
- Test: `src/server/codex/errors.test.ts`
- Modify: `src/server/services/channels.ts`
- Test: `src/server/services/channels.test.ts`

- [ ] Write failing tests for `classifyCodexUpstreamError`: `usage_limit_reached` with `resets_at`, `resets_in_seconds`, context-too-large, model capacity, invalid encrypted content, websocket connection limit.
- [ ] Run `pnpm test src/server/codex/errors.test.ts`; expected: fails because module is missing.
- [ ] Implement `classifyCodexUpstreamError(input)` returning `{ statusCode, code, message, retryAfterMs, credentialScoped, clearReplay, requestScoped }`.
- [ ] Run `pnpm test src/server/codex/errors.test.ts`; expected: pass.
- [ ] Write failing tests for `recordChannelFailure(channel, { statusCode: 429, retryAfterMs })` using explicit cooldown timing.
- [ ] Implement `retryAfterMs` support while preserving existing fixed cooldown fallback.
- [ ] Run `pnpm test src/server/services/channels.test.ts src/server/codex/errors.test.ts`; expected: pass.

### Task 3: Reasoning Replay Cache

**Files:**
- Create: `src/server/codex/reasoningReplay.ts`
- Test: `src/server/codex/reasoningReplay.test.ts`
- Modify: `src/server/codex/client.ts`
- Modify: `src/server/http/relay.ts`

- [ ] Write failing tests for session-key extraction from payload and headers.
- [ ] Write failing tests for injecting a cached reasoning item into `input` without duplicating existing reasoning.
- [ ] Write failing tests for caching `response.output` reasoning/function calls from completed responses.
- [ ] Write failing tests for clearing cache on invalid encrypted content.
- [ ] Run `pnpm test src/server/codex/reasoningReplay.test.ts`; expected: fails because module is missing.
- [ ] Implement bounded TTL replay store with `getCodexReplaySessionKey`, `applyCodexReasoningReplay`, `captureCodexReasoningReplay`, `clearCodexReasoningReplay`.
- [ ] Run `pnpm test src/server/codex/reasoningReplay.test.ts`; expected: pass.
- [ ] Integrate replay in `prepareCodexPayloadForUpstream` or `codexFetch` so upstream payload receives replay items before serialization.
- [ ] Capture replay on non-stream completed responses and stream `response.completed`.
- [ ] Clear replay when classified error sets `clearReplay`.

### Task 4: Stream Error Classification

**Files:**
- Modify: `src/server/http/relay.ts`
- Modify: `src/server/codex/sse.ts` if needed
- Test: `src/server/codex/errors.test.ts`

- [ ] Write failing tests for SSE event classification: `event: error`, `response.failed`, and JSON `type: error`.
- [ ] Implement helpers that classify terminal stream events with `classifyCodexUpstreamError`.
- [ ] Update stream meter error handling to log classified code/message and clear replay when requested.
- [ ] Run `pnpm test src/server/codex/errors.test.ts`; expected: pass.

### Task 5: WebSocket Session Reuse

**Files:**
- Create: `src/server/codex/websocketSession.ts`
- Test: `src/server/codex/websocketSession.test.ts`
- Modify: `src/server/codex/websocket.ts`

- [ ] Write failing tests for session reuse using an injected fake socket factory.
- [ ] Write failing tests that different `credentialId` or upstream URL does not reuse a socket.
- [ ] Write failing tests for send failure reconnecting once.
- [ ] Implement `CodexWebSocketSessionManager` with per-session locks, idle expiry, credential isolation, and reconnect-on-send-failure.
- [ ] Run `pnpm test src/server/codex/websocketSession.test.ts`; expected: pass.
- [ ] Integrate reusable sessions into `codexWebSocketResponse`; fall back to the current single-use path when no reusable session key exists or reuse fails.

### Task 6: Verification

**Files:**
- All touched files

- [ ] Run `pnpm test`; expected: all tests pass.
- [ ] Run `pnpm lint`; expected: no lint errors.
- [ ] Run `pnpm build`; expected: Next build succeeds.
- [ ] Inspect `git diff --stat` and `git diff` for accidental unrelated changes.

