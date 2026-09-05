import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { AdminOverviewPage } from "@/components/admin/admin-overview-page"
import type { UsageReport } from "@/lib/api"

const usage: UsageReport = {
  days: 30,
  user_id: "admin",
  summary: {
    requests: 12,
    errors: 2,
    tokens: 1200,
    prompt_tokens: 700,
    completion_tokens: 500,
    cached_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    image_input_tokens: 0,
    cached_image_input_tokens: 0,
    image_output_tokens: 0,
    cost_nano_usd: 100,
    subscription_covered_nano_usd: 0,
    balance_charged_nano_usd: 100,
  },
  daily: [],
  models: [],
  api_keys: [],
  users: [],
}

describe("admin overview", () => {
  it("opens request logs from the today errors action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
        const body = path.includes("/api/admin/overview")
          ? {
              users: 4,
              enabled_users: 3,
              active_api_keys: 5,
              pending_invitations: 1,
              today: {
                requests: 12,
                tokens: 1200,
                cost_nano_usd: 100,
                errors: 2,
              },
            }
          : path.includes("/api/admin/usage")
            ? usage
            : { items: [] }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      })
    )
    const onPageChange = vi.fn()
    const screen = await render(
      <AdminOverviewPage onPageChange={onPageChange} />
    )

    await expect
      .element(screen.getByRole("link", { name: /今日错误/ }))
      .toHaveAttribute("href", "/admin/logs")
    await screen.getByRole("link", { name: /今日错误/ }).click()
    expect(onPageChange).toHaveBeenCalledWith("logs")
  })
})
