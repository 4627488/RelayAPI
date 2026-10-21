import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { page } from "vitest/browser"
import { AssignUsersDialog } from "./assign-users-dialog"
import { UsersView } from "./users-view"
import { expectNoA11yViolations } from "@/test/a11y"
import type { User } from "@/lib/api"

const { apiMock, postMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  postMock: vi.fn(),
}))
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: apiMock,
  postJSON: postMock,
}))

const users = [
  {
    id: "alice",
    name: "Alice",
    owner_email: "alice@example.test",
    enabled: true,
    balance_nano_usd: 0,
  },
  {
    id: "bob",
    name: "Bob",
    owner_email: "bob@example.test",
    enabled: true,
    balance_nano_usd: 0,
  },
  {
    id: "carol",
    name: "Carol",
    owner_email: "carol@example.test",
    enabled: true,
    balance_nano_usd: 0,
  },
  {
    id: "disabled",
    name: "Disabled",
    owner_email: "disabled@example.test",
    enabled: false,
    balance_nano_usd: 0,
  },
] as User[]

function setup(mode = "observed", existing = false) {
  postMock.mockReset().mockResolvedValue({ items: [] })
  apiMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/tenants")) return { items: users }
    if (path.endsWith("/children"))
      return {
        items: existing
          ? [
              {
                id: "grant",
                tenant_id: "alice",
                parent_subscription_id: "source",
                enabled: true,
              },
            ]
          : [],
      }
    return {
      items: [
        {
          item: {
            id: "source",
            name: "团队模型来源",
            provider: "openai",
            plan_type: "pro",
            status: "active",
            enabled: true,
            capacity_mode: mode,
            upstream_model_allowlist: ["gpt-5"],
            model_allowlist: [],
          },
          allocated_ppm: 400000,
          windows:
            mode === "observed"
              ? [{ kind: "monthly", limit_nano_usd: 100000000000 }]
              : [],
        },
      ],
    }
  })
}

describe("user assignment", () => {
  it("updates the default product name with the share and preserves manual names", async () => {
    setup()
    const screen = await render(
      <AssignUsersDialog
        initialUserIDs={["alice"]}
        fixedParentID="source"
        onOpenChange={() => {}}
      />
    )
    const name = screen.getByLabelText("用户看到的订阅名")
    await expect.element(name).toHaveValue("ChatGPT Pro 2X")
    await screen.getByLabelText("每人份额（%）").fill("12.5")
    await expect.element(name).toHaveValue("ChatGPT Pro 2.5X")
    await name.fill("研发组订阅")
    await screen.getByLabelText("每人份额（%）").fill("25")
    await expect.element(name).toHaveValue("研发组订阅")
    await screen.getByRole("button", { name: "确认分配给 1 人" }).click()
    expect(postMock).toHaveBeenCalledWith(
      "/api/admin/subscriptions/children",
      expect.objectContaining({ name: "研发组订阅", allocation_ppm: 250000 })
    )
  })
  it.each([390, 1280])(
    "previews and submits a shared batch at %s",
    async (width) => {
      setup()
      await page.viewport(width, 900)
      const closed = vi.fn()
      const screen = await render(
        <AssignUsersDialog
          initialUserIDs={["alice", "bob"]}
          fixedParentID="source"
          onOpenChange={closed}
        />
      )
      await expect
        .element(screen.getByLabelText("用户看到的订阅名"))
        .toBeVisible()
      await screen.getByLabelText("用户看到的订阅名").fill("研发共享订阅")
      await expect
        .element(screen.getByText("每人 10% · 本次共 20%", { exact: true }))
        .toBeVisible()
      await expect
        .element(page.getByRole("checkbox", { name: "选择 Disabled" }))
        .toBeDisabled()
      expect(postMock).not.toHaveBeenCalled()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await expectNoA11yViolations(document.querySelector('[role="dialog"]')!)
      await screen.getByRole("button", { name: "确认分配给 2 人" }).click()
      expect(postMock).toHaveBeenCalledWith(
        "/api/admin/subscriptions/children",
        expect.objectContaining({
          tenant_ids: ["alice", "bob"],
          name: "研发共享订阅",
          allocation_ppm: 100000,
          expires_at: "",
          model_allowlist: [],
        })
      )
      expect(closed).toHaveBeenCalledWith(false)
    }
  )

  it("evenly divides remaining share and applies a common expiry", async () => {
    setup()
    const screen = await render(
      <AssignUsersDialog
        initialUserIDs={["alice", "bob", "carol"]}
        fixedParentID="source"
        onOpenChange={() => {}}
      />
    )
    await expect
      .element(screen.getByLabelText("用户看到的订阅名"))
      .toBeVisible()
    await screen.getByRole("button", { name: "均分剩余份额" }).click()
    await expect
      .element(screen.getByText("每人 20% · 本次共 60%", { exact: true }))
      .toBeVisible()
    await screen.getByRole("combobox", { name: "订阅有效期" }).click()
    await screen.getByRole("option", { name: "30 天", exact: true }).click()
    const started = Date.now()
    await screen.getByRole("button", { name: "确认分配给 3 人" }).click()
    const payload = postMock.mock.calls[0][1]
    expect(payload.allocation_ppm).toBe(200000)
    expect(Date.parse(payload.expires_at) - started).toBeGreaterThan(
      29 * 86400000
    )
    expect(Date.parse(payload.expires_at) - Date.parse(payload.starts_at)).toBe(
      30 * 86400000
    )
  })

  it("skips existing access and sends only balance grant fields", async () => {
    setup("unmetered", true)
    const screen = await render(
      <AssignUsersDialog
        initialUserIDs={["alice", "bob"]}
        fixedParentID="source"
        onOpenChange={() => {}}
      />
    )
    await expect
      .element(screen.getByText("新增 1 位用户 · 1 位已有授权，跳过"))
      .toBeVisible()
    await screen.getByRole("button", { name: "确认分配给 1 人" }).click()
    expect(postMock).toHaveBeenCalledWith("/api/admin/subscriptions/children", {
      parent_subscription_id: "source",
      tenant_ids: ["bob"],
    })
  })

  it("preserves selection after a failed submission", async () => {
    setup()
    postMock.mockRejectedValueOnce(new Error("暂时无法保存"))
    const screen = await render(
      <AssignUsersDialog
        initialUserIDs={["bob"]}
        fixedParentID="source"
        onOpenChange={() => {}}
      />
    )
    const submit = screen.getByRole("button", { name: "确认分配给 1 人" })
    await expect.element(submit).toBeEnabled()
    await submit.click()
    await expect.element(screen.getByText("暂时无法保存")).toBeVisible()
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Bob", exact: true }))
      .toBeChecked()
    await submit.click()
    expect(postMock).toHaveBeenCalledTimes(2)
  })

  it("opens assignment directly from selected users", async () => {
    setup()
    await page.viewport(1280, 900)
    const screen = await render(
      <main>
        <UsersView
          users={users}
          currentUserId="admin"
          onChanged={async () => {}}
        />
      </main>
    )
    await screen.getByLabelText("选择 Alice", { exact: true }).click()
    await screen.getByLabelText("选择 Bob", { exact: true }).click()
    await screen
      .getByRole("button", { name: "分配给 2 人", exact: true })
      .click()
    const dialog = screen.getByRole("dialog", { name: "分配给用户" })
    await expect
      .element(
        dialog.getByRole("checkbox", { name: "选择 Alice", exact: true })
      )
      .toBeChecked()
    await expect
      .element(dialog.getByRole("checkbox", { name: "选择 Bob", exact: true }))
      .toBeChecked()
  })
})
