import { afterEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { TenantSubscriptionsView } from "@/components/subscriptions-view"
import { api, type TenantSubscription } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))
const now = Date.parse("2026-10-15T04:00:00Z")
function subscription(
  patch: Partial<TenantSubscription> = {}
): TenantSubscription {
  return {
    id: "shared",
    name: "研发月度订阅",
    enabled: true,
    available: true,
    starts_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-17T04:00:00Z",
    capacity_mode: "observed",
    billing_mode: "quota",
    model_allowlist: [],
    effective_model_allowlist: ["gpt-test"],
    canonical_model_allowlist: ["openai/gpt-test"],
    reset_history: [],
    entitlement_windows: [
      {
        kind: "5h",
        allocation_ppm: 100000,
        parent_limit_nano_usd: 100000000000,
        limit_nano_usd: 10000000000,
        remaining_nano_usd: 7000000000,
        settled_nano_usd: 2000000000,
        reserved_nano_usd: 1000000000,
        resets_at: "2026-10-15T09:00:00Z",
        source: "observed",
      },
    ],
    ...patch,
  }
}
afterEach(async () => {
  document.documentElement.classList.remove("dark")
  await page.viewport(1280, 800)
})

describe("personal shared subscriptions", () => {
  it.each([
    { width: 390, dark: false },
    { width: 1280, dark: true },
  ])(
    "shows private flat quota rows at $width with dark=$dark",
    async ({ width, dark }) => {
      vi.spyOn(Date, "now").mockReturnValue(now)
      await page.viewport(width, 900)
      document.documentElement.classList.toggle("dark", dark)
      const item = {
        ...subscription(),
        parent_name: "secret-upstream@example.test",
        parent_plan_type: "private-plan",
        availability_message: "secret diagnostic@example.test",
      }
      vi.mocked(api).mockResolvedValue({
        items: [
          item,
          subscription({
            id: "balance",
            name: "余额私有账户",
            capacity_mode: "unmetered",
            billing_mode: "balance",
            entitlement_windows: [],
          }),
        ],
      })
      const screen = await render(
        <main className="p-4">
          <TenantSubscriptionsView />
        </main>
      )
      await expect
        .element(screen.getByRole("heading", { name: "研发月度订阅" }))
        .toBeVisible()
      await expect
        .element(screen.getByText("70%", { exact: true }))
        .toBeVisible()
      await expect
        .element(screen.getByText("5 小时后重置", { exact: true }))
        .toBeVisible()
      await expect
        .element(screen.getByText("剩余 2 天", { exact: true }))
        .toBeVisible()
      await screen
        .getByRole("button", { name: "模型与重置记录 · 1 个模型" })
        .click()
      await expect
        .element(screen.getByText("openai/gpt-test", { exact: true }))
        .toBeVisible()
      const text = document.body.innerText
      expect(text).not.toContain("secret-upstream")
      expect(text).not.toContain("diagnostic@example.test")
      expect(text).not.toContain("余额私有账户")
      expect(document.querySelector('[data-slot="card"]')).toBeNull()
      const track = document.querySelector('[data-slot="progress-track"]')!
      expect(track.getBoundingClientRect().height).toBeGreaterThanOrEqual(12)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await expectNoA11yViolations()
    }
  )
  it("distinguishes expiry, scheduled activation and reset beyond expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now)
    vi.mocked(api).mockResolvedValue({
      items: [
        subscription({
          id: "expired",
          name: "已结束订阅",
          expires_at: "2026-10-14T00:00:00Z",
        }),
        subscription({
          id: "soon",
          name: "短期订阅",
          expires_at: "2026-10-15T05:00:00Z",
        }),
        subscription({
          id: "future",
          name: "下月订阅",
          starts_at: "2026-11-01T00:00:00Z",
          expires_at: null,
        }),
      ],
    })
    const screen = await render(<TenantSubscriptionsView />)
    await expect
      .element(screen.getByText("已到期", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("待生效", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("订阅将在下次额度重置前到期"))
      .toBeVisible()
    await expect
      .element(screen.getByText("长期有效", { exact: true }))
      .toBeVisible()
  })
  it("keeps unknown and exhausted quota distinct", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now)
    const a = subscription()
    vi.mocked(api).mockResolvedValue({
      items: [
        subscription({
          id: "zero",
          entitlement_windows: [
            { ...a.entitlement_windows![0], remaining_nano_usd: 0 },
          ],
        }),
        subscription({
          id: "unknown",
          entitlement_windows: [
            { ...a.entitlement_windows![0], limit_nano_usd: 0 },
          ],
        }),
      ],
    })
    const screen = await render(<TenantSubscriptionsView />)
    await expect
      .element(screen.getByText("额度已用尽", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("已用尽", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("/ 额度待同步", { exact: true }))
      .toBeVisible()
  })
})
