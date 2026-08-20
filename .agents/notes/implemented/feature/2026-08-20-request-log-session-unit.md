# Agent Note: Request log unit is one Relay call

Status: implemented

## 口径

`request_logs` 一行 = 用户对 Relay 的一次调用，不是上游的一次
attempt，也不是 SSE 的一帧或 WebSocket 的一轮。

| 传输 | 一行代表 | 不拆成多行 |
| HTTP JSON | 一次 HTTP 请求/响应 | Admit / Serve / Settle |
| SSE | 同上；`stream=true` 只是传输属性 | 每个 `data:` 事件 |
| WebSocket | 一次连接（会话） | 每个 `response.create` 轮次 |

轮次、帧、OAuth refresh、额度探测、健康检查、管理端测模型
都不进 `request_logs`。WS 轮次只写 `websocket_turns`，详情里展开。

## Decision

Stop writing one `request_logs` row per billed WS turn. Accrue still
inserts `websocket_turns` and upserts the **session** row with cumulative
tokens, bytes, and cost. Session close always upserts that same row
(timeline, settle, error). List, dashboard, usage, admin today, and retention request
counts treat
`reservation_request_id IS NULL OR reservation_request_id = id` as the
unit. Token, cost, and byte sums still include historical child-turn
rows so old multi-turn totals are not lost. SSE stays one HTTP row with
TTFT on that row.

## Alternatives considered

**Keep turn rows and group in the UI.** List, dashboard, and daily-token
deltas would keep double-counting unless every reader remembered the
filter.

**Session row plus turn rows marked `log_kind`.** Two grains in one table
still leak into `count(*)` and rollups.

## Consequences

A three-turn WS session is one list row. Opening it shows the turns.
Old first-turn rows remain addressable; old extra turn rows are hidden
from the unit list. Tenant redaction unchanged.
