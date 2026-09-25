import { afterEach, expect, it, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import { RequestLogList } from "./request-log-list"
import { RequestLogInsight } from "./request-log-insight"
import { parseLatencyTrace } from "@/lib/latency-trace"
import type { RequestLog } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

const log = {
  id: "observation-1",
  model: "test-model",
  actual_model: "upstream-model",
  requested_model: "requested-model",
  method: "POST",
  path: "/v1/responses",
  status_code: 200,
  stream: true,
  started_at: "2026-09-25T01:00:00Z",
  latency_ms: 1200,
  ttft_ms: 0,
  first_token_ms: 320,
  total_tokens: 1500,
  prompt_tokens: 1000,
  completion_tokens: 500,
  cached_tokens: 800,
  cost_nano_usd: 0,
  pricing_complete: false,
  settled: false,
  stage_timings: JSON.stringify({
    version: 5,
    total_ms: 1200,
    segments: [
      {
        id: "attempt",
        label: "上游尝试",
        start_ms: 0.125,
        duration_ms: 1199.875,
        attempt: 2,
        provider: "provider-test",
        model: "upstream-model",
        credential: "credential-test",
        error: "observed-error",
        reused: false,
        remote_addr: "127.0.0.1:443",
      },
      { id: "billing", label: "计费处理", start_ms: 1200, duration_ms: 20 },
    ],
    marks: [{ id: "first", label: "首个响应事件", offset_ms: 210.5 }],
  }),
} as RequestLog

afterEach(async () => {
  await page.viewport(1280, 800)
})

it("opens v5 observations on hover and keeps rich details reachable", async () => {
  const screen = await render(
    <RequestLogInsight log={log} section="latency">
      1.2 s
    </RequestLogInsight>
  )
  await screen.getByRole("button", { name: "查看耗时详情" }).hover()
  const popup = screen.getByRole("dialog", { name: "请求观测详情" })
  await expect.element(popup).toBeVisible()
  await popup.hover()
  await expect
    .element(popup.getByText("0.125 ms", { exact: true }))
    .toBeVisible()
  await expect
    .element(popup.getByText("credential-test", { exact: true }))
    .toBeVisible()
  await expect
    .element(popup.getByText("observed-error", { exact: true }))
    .toBeVisible()
  await expect
    .element(popup.getByText("210.5 ms", { exact: true }))
    .toBeVisible()
  await popup.getByRole("tab", { name: "用量", exact: true }).click()
  await expect.element(popup.getByText("800", { exact: true })).toBeVisible()
  await popup.getByRole("tab", { name: "计费", exact: true }).click()
  await expect
    .element(popup.getByText("定价完成", { exact: true }))
    .toBeVisible()
  await expectNoA11yViolations()
  await userEvent.keyboard("{Escape}")
  await expect.element(popup).not.toBeInTheDocument()
})

it("opens with keyboard activation and closes with Escape", async () => {
  const screen = await render(
    <RequestLogInsight log={log} section="latency">
      1.2 s
    </RequestLogInsight>
  )
  await userEvent.tab()
  await userEvent.keyboard("{Enter}")
  await expect
    .element(screen.getByRole("dialog", { name: "请求观测详情" }))
    .toBeVisible()
  await userEvent.keyboard("{Escape}")
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument()
})

it.each([320, 1280])(
  "shows a popup without navigating the log at width %s",
  async (width) => {
    await page.viewport(width, 800)
    const onOpen = vi.fn()
    const screen = await render(
      <main>
        <RequestLogList logs={[log]} onOpen={onOpen} />
      </main>
    )
    await screen.getByRole("button", { name: "查看耗时详情" }).click()
    const popup = screen.getByRole("dialog", { name: "请求观测详情" })
    await expect.element(popup).toBeVisible()
    expect(onOpen).not.toHaveBeenCalled()
    const rect = popup.element().getBoundingClientRect()
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(width)
    await popup.getByRole("tab", { name: "链路", exact: true }).click()
    await expect
      .element(popup.getByText("requested-model", { exact: true }))
      .toBeVisible()
    await expectNoA11yViolations()
    await userEvent.keyboard("{Escape}")
    await screen.getByRole("link", { name: /查看日志/ }).click()
    expect(onOpen).toHaveBeenCalledWith(log)
  }
)

it("handles missing and malformed telemetry without fabricating measurements", async () => {
  expect(parseLatencyTrace("null")).toBeNull()
  expect(
    parseLatencyTrace('{"version":4,"segments":[],"total_ms":1}')
  ).toBeNull()
  const malformed = JSON.stringify({
    version: 5,
    total_ms: 0,
    segments: [
      null,
      { label: "bad", start_ms: -1, duration_ms: 2 },
      { label: "zero", start_ms: 0, duration_ms: 0 },
    ],
    marks: [null, { label: "bad", offset_ms: "1" }],
  })
  expect(parseLatencyTrace(malformed)?.segments).toHaveLength(1)
  expect(parseLatencyTrace(malformed)?.marks).toEqual([])
  const screen = await render(
    <RequestLogInsight
      log={{ ...log, stage_timings: "{}", first_token_ms: undefined }}
      section="latency"
    >
      1.2 s
    </RequestLogInsight>
  )
  await screen.getByRole("button", { name: "查看耗时详情" }).click()
  await expect
    .element(screen.getByText("此记录没有可展示的 v5 阶段观测。"))
    .toBeVisible()
  await expect.element(screen.getByText("0 ms", { exact: true })).toBeVisible()
  await expect
    .element(screen.getByText("未记录", { exact: true }))
    .toBeVisible()
})
