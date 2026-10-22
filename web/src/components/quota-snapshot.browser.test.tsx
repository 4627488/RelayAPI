import { describe, expect, it } from "vitest"
import { render } from "vitest-browser-react"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import type { UpstreamQuotaReport } from "@/lib/api"

const snapshot: UpstreamQuotaReport = {
  supported: true,
  plan_type: "max",
  subscription: {
    status: "supported",
    source: "claude-oauth-profile",
    rate_limit_tier: "default_claude_max_20x",
    subscription_status: "active",
  },
  windows: [
    {
      kind: "extra-usage",
      label: "额外用量",
      enforceable: false,
      used: 12.34,
      limit: 100,
      remaining: 87.66,
      used_percent: 12.34,
      unit: "USD",
      enabled: true,
    },
  ],
}

describe("upstream quota snapshot", () => {
  it("shows live plan tier and normalized extra usage amounts", async () => {
    const screen = await render(<QuotaSnapshot snapshot={snapshot} />)
    await expect
      .element(screen.getByText("default_claude_max_20x"))
      .toBeVisible()
    await expect.element(screen.getByText("套餐已实时探测")).toBeVisible()
    await expect
      .element(screen.getByText(/已用 12.34 \/ 100 USD/))
      .toBeVisible()
  })

  it("shows a failed profile without hiding quota", async () => {
    const screen = await render(
      <QuotaSnapshot
        snapshot={{
          ...snapshot,
          subscription: {
            status: "error",
            source: "credential",
            error_code: "forbidden",
          },
        }}
        compact
      />
    )
    await expect
      .element(screen.getByText("套餐查询失败 · 信息可能过期"))
      .toBeVisible()
    await expect
      .element(screen.getByText(/已用 12.34 \/ 100 USD/))
      .toBeVisible()
  })

  it("shows subscription metadata even before usable quota", async () => {
    const screen = await render(
      <QuotaSnapshot snapshot={{ ...snapshot, windows: [] }} status="error" />
    )
    await expect.element(screen.getByText("max", { exact: true })).toBeVisible()
    await expect.element(screen.getByText("套餐已实时探测")).toBeVisible()
    await expect.element(screen.getByText("额度探测失败")).toBeVisible()
  })

  it("explains inference-only token capability", async () => {
    const screen = await render(
      <QuotaSnapshot
        snapshot={{
          supported: false,
          windows: [],
          subscription: {
            status: "unsupported",
            source: "credential",
            error_code: "missing_profile_scope",
          },
        }}
        status="unsupported"
      />
    )
    await expect
      .element(screen.getByText("当前令牌缺少账户查询权限，请重新授权"))
      .toBeVisible()
  })

  it("keeps unlimited extra spend and disabled state visible", async () => {
    const screen = await render(
      <QuotaSnapshot
        snapshot={{
          supported: true,
          windows: [
            {
              kind: "extra-usage",
              label: "额外用量",
              enforceable: false,
              used: 12.34,
              unit: "USD",
              enabled: false,
            },
          ],
        }}
        compact
      />
    )
    await expect
      .element(screen.getByText("未启用 · 已用 12.34 USD"))
      .toBeVisible()
  })
})
