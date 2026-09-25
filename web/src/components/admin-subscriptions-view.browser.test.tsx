import { afterEach, describe, expect, it, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import { AdminSubscriptionsView } from "@/components/admin-subscriptions-view"
import {
  api,
  deleteRequest,
  type ParentSubscriptionView,
  type ChildSubscription,
} from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
  deleteRequest: vi.fn(),
}))

const parents = ["observed", "unmetered"].map((mode, index) => ({
  item: {
    id: `parent-${index}`,
    name: index ? "Kimi 团队账户" : "研发共享账户",
    provider: index ? "kimi" : "codex",
    plan_type: "pro",
    status: "active",
    enabled: true,
    capacity_mode: mode,
    model_allowlist: ["model-a", "model-b"],
    upstream_model_allowlist: [],
    quota_probe_status: "supported",
  },
  allocated_ppm: 400000,
  windows: index
    ? []
    : [
        {
          kind: "weekly",
          limit_nano_usd: 100000000000,
          settled_nano_usd: 20000000000,
          reserved_nano_usd: 0,
          resets_at: "2026-09-14T00:00:00Z",
        },
      ],
})) as unknown as ParentSubscriptionView[]
const grants = Array.from({ length: 6 }, (_, index) => ({
  id: `grant-${index}`,
  parent_subscription_id: "parent-0",
  tenant_id: `tenant-${index}`,
  name: `研发授权 ${index}`,
  enabled: index !== 2,
  allocation_ppm: 100000,
  priority: 100,
  model_allowlist: [],
  entitlement_windows: [],
})) as unknown as ChildSubscription[]

afterEach(async () => {
  await page.viewport(1280, 800)
})

describe("subscription allocation", () => {
  it("confirms account deletion, keeps failed deletion retryable, and refreshes after success", async () => {
    const unavailable = {
      ...parents[0],
      item: {
        ...parents[0].item,
        upstream_unavailable: true,
        upstream_credential_id: "account/one",
      },
    }
    let deleted = false
    vi.mocked(api).mockImplementation(async (path) => ({
      items: path.endsWith("parents") ? (deleted ? [] : [unavailable]) : [],
    }))
    vi.mocked(deleteRequest).mockReset()
    vi.mocked(deleteRequest).mockRejectedValueOnce(new Error("删除失败"))
    vi.mocked(deleteRequest).mockImplementationOnce(async () => {
      deleted = true
    })
    const screen = await render(<AdminSubscriptionsView />)
    await screen.getByRole("button", { name: "删除账户", exact: true }).click()
    expect(deleteRequest).not.toHaveBeenCalled()
    await screen.getByRole("button", { name: "取消", exact: true }).click()
    expect(deleteRequest).not.toHaveBeenCalled()
    await screen.getByRole("button", { name: "删除账户", exact: true }).click()
    await screen.getByRole("button", { name: "确认删除账户" }).click()
    await expect
      .element(screen.getByRole("button", { name: "确认删除账户" }))
      .toBeEnabled()
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
    await screen.getByRole("button", { name: "确认删除账户" }).click()
    await expect.poll(() => deleted).toBe(true)
    expect(deleteRequest).toHaveBeenLastCalledWith(
      "/api/admin/providers/accounts/account%2Fone"
    )
    await expect
      .element(screen.getByRole("alertdialog"))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole("heading", { name: "研发共享账户" }))
      .not.toBeInTheDocument()
  })

  it.each([390, 1280])(
    "keeps allocation controls compact and usable at %s",
    async (width) => {
      await page.viewport(width, 900)
      vi.mocked(api).mockImplementation(async (path) => ({
        items: path.endsWith("parents")
          ? parents
          : path.endsWith("children")
            ? grants
            : grants.map((grant, index) => ({
                id: grant.tenant_id,
                name: `用户 ${index}`,
                owner_email: `developer${index}@example.com`,
                enabled: true,
              })),
      }))
      const screen = await render(
        <main className="min-w-0 p-4">
          <AdminSubscriptionsView />
        </main>
      )
      await expect
        .element(screen.getByRole("heading", { name: "研发共享账户" }))
        .toBeVisible()
      expect(document.querySelector('[data-slot="card"]')).toBeNull()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await expectNoA11yViolations()
      await screen
        .getByRole("textbox", { name: "搜索租户授权" })
        .fill("developer3")
      await expect
        .poll(() => document.body.innerText)
        .toContain("developer3@example.com")
      await expect
        .poll(() => document.body.innerText)
        .not.toContain("developer0@example.com")
      await screen.getByRole("button", { name: "管理 研发授权 3" }).click()
      await expect
        .element(screen.getByRole("menuitem", { name: "编辑授权" }))
        .toBeVisible()
      await userEvent.keyboard("{Escape}")
      await screen.getByRole("button", { name: /Kimi 团队账户/ }).click()
      await expect
        .element(screen.getByRole("heading", { name: "Kimi 团队账户" }))
        .toBeVisible()
      await expect
        .element(screen.getByRole("textbox", { name: "搜索租户授权" }))
        .toHaveValue("")
      await screen
        .getByRole("button", { name: "添加用户", exact: true })
        .first()
        .click()
      await expect
        .element(screen.getByRole("dialog", { name: "授权用户" }))
        .toBeVisible()
    }
  )
})
