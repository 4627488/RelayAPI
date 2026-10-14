import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { page } from "vitest/browser"
import { expectNoA11yViolations } from "@/test/a11y"

import { ProvidersView } from "@/components/providers-view"
import type { ProviderAccount } from "@/lib/api"

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: apiMock,
    postJSON: vi.fn(),
    deleteRequest: vi.fn(),
  }
})

const accounts: ProviderAccount[] = [
  {
    id: "openai-1",
    name: "主账户",
    label: "Alice OpenAI",
    email: "alice@example.com",
    provider: "openai",
    auth_kind: "api_key",
    source: "api_key",
    disabled: false,
    models: ["gpt-4.1"],
    base_url: "https://api.openai.example/v1",
    success: 12,
    failed: 1,
  },
  {
    id: "kimi-1",
    name: "Kimi 冷却",
    email: "bob@example.com",
    provider: "kimi",
    auth_kind: "oauth",
    source: "oauth",
    disabled: false,
    unavailable: true,
    status: "cooldown",
    status_message: "上游返回 429",
    next_retry_after: "2026-09-06T12:00:00Z",
    models: [],
    base_url: "https://api.moonshot.cn/v1",
  },
]

function setup(value: ProviderAccount[] = accounts) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/admin/providers/accounts")
      return Promise.resolve({ files: value })
    if (path === "/api/admin/proxies") return Promise.resolve({ items: [] })
    return Promise.resolve({})
  })
}

describe("providers view", () => {
  it.each([390, 1280])(
    "opens only the chosen account's grants at %s",
    async (width) => {
      await page.viewport(width, 900)
      const parents = accounts.map((account, index) => ({
        item: {
          id: `parent-${index}`,
          upstream_credential_id: account.id,
          name: account.name,
          provider: account.provider,
          status: "active",
          enabled: true,
          capacity_mode: "unmetered",
          model_allowlist: [],
          upstream_model_allowlist: account.models,
          quota_probe_status: "unsupported",
        },
        allocated_ppm: 0,
        windows: [],
      }))
      apiMock.mockImplementation(async (path: string) => {
        if (path.endsWith("/accounts")) return { files: accounts }
        if (path.endsWith("/parents")) return { items: parents }
        if (path.endsWith("/children"))
          return {
            items: [
              {
                id: "grant-1",
                parent_subscription_id: "parent-0",
                tenant_id: "tenant-1",
                enabled: true,
                name: "Alice 授权",
                model_allowlist: [],
                billing_mode: "balance",
                entitlement_windows: [],
              },
            ],
          }
        if (path.endsWith("/tenants"))
          return {
            items: [
              {
                id: "tenant-1",
                name: "研发用户",
                owner_email: "dev@example.com",
                enabled: true,
              },
            ],
          }
        return { items: [] }
      })
      const screen = await render(
        <main className="p-4">
          <ProvidersView />
        </main>
      )
      await screen
        .getByRole("button", { name: "1 位用户", exact: true })
        .click()
      await expect
        .element(screen.getByRole("tab", { name: "用户授权", selected: true }))
        .toBeVisible()
      await expect
        .element(screen.getByText("研发用户", { exact: true }).first())
        .toBeVisible()
      await expect
        .element(screen.getByRole("button", { name: "Kimi 冷却" }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole("button", { name: "结算与额度规则" }))
        .toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await expectNoA11yViolations(document.querySelector('[role="dialog"]')!)
      await screen
        .getByRole("button", { name: "添加用户", exact: true })
        .click()
      await expect
        .element(screen.getByRole("dialog", { name: "授权用户" }))
        .toBeVisible()
      await expect.element(screen.getByRole("combobox")).toBeDisabled()
      await screen.getByRole("button", { name: "取消", exact: true }).click()
      await screen.getByRole("button", { name: "关闭", exact: true }).click()
      await page.viewport(1280, 800)
    }
  )
  it("searches account identity, model, and endpoint", async () => {
    setup()
    const screen = await render(<ProvidersView />)
    await expect
      .element(screen.getByText("Alice OpenAI", { exact: true }))
      .toBeVisible()

    const search = screen.getByPlaceholder("搜索名称、邮箱、模型或 Base URL")
    await search.fill("alice@example.com")
    await expect
      .element(screen.getByText("Alice OpenAI", { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByText("Kimi 冷却")).not.toBeInTheDocument()
    await search.fill("gpt-4.1")
    await expect
      .element(screen.getByText("Alice OpenAI", { exact: true }))
      .toBeVisible()
    await search.fill("moonshot.cn")
    await expect
      .element(screen.getByText("bob@example.com", { exact: true }))
      .toBeVisible()
  })

  it("filters by provider, status, and authentication", async () => {
    setup()
    const screen = await render(<ProvidersView />)
    await screen.getByRole("combobox").nth(0).click()
    await screen.getByRole("option", { name: "Kimi" }).click()
    await expect
      .element(screen.getByText("bob@example.com", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("Alice OpenAI", { exact: true }))
      .not.toBeInTheDocument()

    await screen.getByRole("button", { name: "冷却" }).click()
    await expect
      .element(screen.getByText("bob@example.com", { exact: true }))
      .toBeVisible()
    await screen.getByRole("combobox").nth(1).click()
    await screen.getByRole("option", { name: "API Key" }).click()
    await expect
      .element(screen.getByText("bob@example.com", { exact: true }))
      .not.toBeInTheDocument()
  })

  it("shows a retryable error instead of a false empty state", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/api/admin/providers/accounts")
        return Promise.reject(new Error("服务暂不可用"))
      return Promise.resolve({ items: [] })
    })
    const screen = await render(<ProvidersView />)
    await expect.element(screen.getByText("账户数据读取失败")).toBeVisible()
    await expect
      .element(screen.getByText("还没有模型账户"))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole("button", { name: "重试" }))
      .toBeVisible()
  })

  it("disables testing for disabled or unpublished accounts", async () => {
    setup([
      { ...accounts[0], disabled: true },
      { ...accounts[1], unavailable: false, status: undefined },
    ])
    const screen = await render(<ProvidersView />)
    const testButtons = screen.getByRole("button", { name: "测试" })
    await expect.element(testButtons.nth(0)).toBeDisabled()
    await expect.element(testButtons.nth(1)).toBeDisabled()
  })
})
