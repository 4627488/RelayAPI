import { afterEach, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { OverviewPage } from "./overview-page"
import { UsageView } from "./usage-view"
import { analyticsFixture } from "@/test/analytics-fixture"
import { expectNoA11yViolations } from "@/test/a11y"
import { api, type Session } from "@/lib/api"
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))
const session = {
  tenant: { id: "tenant", name: "User", balance_nano_usd: 1000000000 },
} as Session
function setup() {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/api/usage"))
      return {
        ...analyticsFixture,
        user_id: "tenant",
        days: Number(new URL(path, "http://test").searchParams.get("days")),
      }
    if (path === "/api/me") return session
    if (path === "/api/subscriptions")
      throw new Error("temporarily unavailable")
    if (path === "/api/keys") return { items: [{ id: "key", enabled: true }] }
    return { items: [] }
  })
}
afterEach(async () => {
  vi.mocked(api).mockReset()
  await page.viewport(1280, 800)
})
it.each([390, 1280])(
  "loads tenant-only data and isolates an optional failure at %s",
  async (width) => {
    setup()
    await page.viewport(width, 900)
    const screen = await render(
      <main className="p-4">
        <OverviewPage session={session} onPageChange={() => {}} />
      </main>
    )
    await expect
      .element(screen.getByText("我的账户", { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByText(/订阅读取失败/)).toBeVisible()
    await expect
      .element(screen.getByText("响应性能", { exact: true }))
      .toBeVisible()
    expect(
      vi.mocked(api).mock.calls.some(([p]) => p.startsWith("/api/admin"))
    ).toBe(false)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
    await screen.getByRole("button", { name: "7 天", exact: true }).click()
    await expect
      .element(screen.getByText(/最近 7 天的请求、费用与性能/))
      .toBeVisible()
    await expectNoA11yViolations()
  }
)
it("keeps the successful period labelled after a refresh failure and retries", async () => {
  setup()
  const screen = await render(<UsageView />)
  await expect.element(screen.getByText(/当前展示最近 30 天/)).toBeVisible()
  vi.mocked(api).mockRejectedValueOnce(new Error("offline"))
  await screen.getByRole("button", { name: "7 天", exact: true }).click()
  await expect.element(screen.getByText(/offline/)).toBeVisible()
  await expect.element(screen.getByText(/当前展示最近 30 天/)).toBeVisible()
  await screen.getByRole("button", { name: "刷新", exact: true }).click()
  await expect.element(screen.getByText(/当前展示最近 7 天/)).toBeVisible()
})
