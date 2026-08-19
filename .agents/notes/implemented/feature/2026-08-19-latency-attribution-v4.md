# Agent Note: Latency attribution v4

Status: implemented

## Problem

The request-log chart treated the whole in-process `Serve()` wait as
「运行时」, then lumped post-TTFT into one 「传输」 bar owned by
`downstream`. Operators could not see how much time was client Read/Write
block, local relay work, or provider connect / Body.Read. The header also
named a 「主要阶段」 winner.

## Decision

Record transfer clocks on the provider→client copy: `Body.Read()` wait and
`ResponseWriter.Write`/`Flush` wait, plus byte and call counts. Stop
advancing the critical-path Step across `Serve()`. Persist `stage_timings`
version 4 with three measured buckets:

- `user_network_ms` = client body read + write/flush block
- `relay_ms` = auth, queue, parse, billing, dispatch/translate
- `upstream_ms` = connect/DNS/TCP/TLS/request write/first-byte wait + body read block

Attempt wall-clock bars stay as reference and are not added into the three
buckets. Read and write alternate on one Copy loop, so the observed sum may
exceed wall clock. The log chart shows those numbers, a stacked observed-vs-wall
bar, three Gantt lanes, and the segment table. It does not name a cause.

Old v2/v3 JSON still parses. `response_transfer` / `runtime_response_headers`
become 「未拆分」, not 用户网络.

## Alternatives considered

**Keep one post-TTFT bar and label it 用户 or 上游.** That re-hides the
coupled waits.

**Guess client RTT or provider-internal queue.** Relay cannot observe those
clocks.

**Emit a span per Read/Write.** SSE can produce hundreds of rows; cumulative
waits plus counts are enough.

## Consequences

New logs are comparable across user upload, relay compute, and provider
wait. WebSocket turns remain one mixed wall-clock segment. Tenant APIs
still redact `stage_timings`.
