import { describe, expect, it } from "vitest"
import { render } from "vitest-browser-react"

import { LogsTable, UsageChart } from "@/components/data-views"
import type { RequestLog, UsageReport } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

const usage: UsageReport = {
  days: 30,
  user_id: "tenant-1",
  summary: {
    requests: 20,
    errors: 1,
    tokens: 3600,
    input: 2200,
    output: 1400,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    image_input_tokens: 0,
    cached_image_input_tokens: 0,
    image_output_tokens: 0,
    cost_nano_usd: 100,
    subscription_covered_nano_usd: 0,
    balance_charged_nano_usd: 100,
  },
  daily: [
    {
      date: "2026-09-01",
      requests: 8,
      errors: 1,
      tokens: 1200,
      input: 700,
      output: 500,
      cache_read: 0,
      cost_nano_usd: 40,
    },
  ],
  models: [],
  api_keys: [],
  users: [],
}

const log = {
  id: "request/id?detail=1",
  model: "特殊模型",
  path: "/v1/chat/completions",
  started_at: "2026-09-02T10:20:30Z",
  status_code: 200,
  error_code: undefined,
  client_name: "测试客户端",
  client_version: "1.0",
  user_agent: "browser",
  total_tokens: 42,
  cache_read: 0,
  input: 20,
  latency_ms: 125,
  cost_nano_usd: 100,
} as RequestLog

describe("data views", () => {
  it("switches the usage trend to a single, clearly labelled unit", async () => {
    const screen = await render(<UsageChart report={usage} />)

    await expect.element(screen.getByText(/当前显示单位：请求数/)).toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "请求" }))
      .toHaveAttribute("aria-pressed", "true")
    await screen.getByRole("button", { name: "Tokens" }).click()
    await expect
      .element(screen.getByText(/当前显示单位：Token 数/))
      .toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "Tokens" }))
      .toHaveAttribute("aria-pressed", "true")
    await expectNoA11yViolations()
  })

  it("links each log to an encoded detail route for its workspace", async () => {
    const screen = await render(
      <div>
        <LogsTable logs={[log]} />
        <LogsTable logs={[log]} workspace="admin" />
      </div>
    )

    const links = screen.getByRole("link", { name: /查看请求记录 特殊模型/ })
    await expect
      .element(links.nth(0))
      .toHaveAttribute("href", "/app/logs/request%2Fid%3Fdetail%3D1")
    await expect
      .element(links.nth(1))
      .toHaveAttribute("href", "/admin/logs/request%2Fid%3Fdetail%3D1")
    await expectNoA11yViolations()
  })
})
