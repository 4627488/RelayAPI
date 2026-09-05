import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

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
