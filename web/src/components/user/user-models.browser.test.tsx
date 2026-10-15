import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { UserModels } from "./user-models"
import { api } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))

describe("user model settlement list", () => {
  it("merges model IDs with balance and linked subscriptions and filters by settlement", async () => {
    vi.mocked(api).mockResolvedValue({
      items: [
        {
          id: "gpt-shared",
          settlements: [
            {
              mode: "subscription",
              subscription_id: "share/1",
              subscription_name: "团队订阅",
              available: false,
            },
            { mode: "balance", available: true },
          ],
        },
        {
          id: "balance-only",
          settlements: [{ mode: "balance", available: true }],
        },
      ],
    })
    const screen = await render(
      <main>
        <UserModels />
      </main>
    )
    await expect
      .element(screen.getByRole("link", { name: "团队订阅" }))
      .toHaveAttribute("href", "/app/subscriptions#subscription-share%2F1")
    await expect
      .element(screen.getByText("gpt-shared", { exact: true }))
      .toBeVisible()
    await screen.getByRole("button", { name: "订阅结算", exact: true }).click()
    await expect
      .element(screen.getByText("balance-only", { exact: true }))
      .not.toBeInTheDocument()
    await screen.getByPlaceholder("搜索模型 ID").fill("does-not-exist")
    await expect.element(screen.getByText("没有匹配的模型")).toBeVisible()
    await screen.getByRole("button", { name: "清除筛选" }).click()
    await expect
      .element(screen.getByText("balance-only", { exact: true }))
      .toBeVisible()
    expect(document.querySelector('[data-slot="card"]')).toBeNull()
    await expectNoA11yViolations()
  })
})
