import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { UserKeys } from "@/components/user/user-keys"
import type { ApiKey } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

const keys: ApiKey[] = [
  {
    id: "key-production",
    name: "生产环境",
    prefix: "rly_prod",
    recoverable: true,
    enabled: true,
    rate_limit_per_minute: null,
    token_limit_daily: null,
    model_allowlist: ["gpt-5"],
    model_aliases: [],
    last_used_at: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "key-test",
    name: "旧测试环境",
    prefix: "rly_test",
    recoverable: true,
    enabled: false,
    rate_limit_per_minute: null,
    token_limit_daily: null,
    model_allowlist: [],
    model_aliases: [{ alias: "fast", model: "gpt-5" }],
    last_used_at: null,
    created_at: "2026-01-01T00:00:00Z",
  },
]

function mockKeys(value: ApiKey[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path.includes("/api/subscriptions")
        ? { items: [] }
        : { items: value }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  )
}

describe("user API keys", () => {
  it("filters by status and clears a search without confusing no matches with no keys", async () => {
    mockKeys(keys)
    const screen = await render(<UserKeys tenantModels={[]} />)

    await expect.element(screen.getByText("生产环境")).toBeVisible()
    await expect.element(screen.getByText("旧测试环境")).toBeVisible()

    await screen.getByRole("button", { name: /停用 \(1\)/ }).click()
    await expect.element(screen.getByText("旧测试环境")).toBeVisible()
    await expect.element(screen.getByText("生产环境")).not.toBeInTheDocument()

    const search = screen.getByRole("textbox", { name: "搜索 API 密钥" })
    await search.fill("does-not-exist")
    await expect.element(screen.getByText("没有匹配的 API Key")).toBeVisible()
    await expect
      .element(screen.getByText("还没有 API Key"))
      .not.toBeInTheDocument()
    await screen.getByRole("button", { name: "清除搜索" }).click()
    await expect.element(screen.getByText("旧测试环境")).toBeVisible()
    await expectNoA11yViolations()
  })

  it("shows a creation empty state when the account has no keys", async () => {
    mockKeys([])
    const screen = await render(<UserKeys tenantModels={[]} />)

    await expect.element(screen.getByText("还没有 API Key")).toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "创建第一个 Key" }))
      .toBeVisible()
    await expectNoA11yViolations()
  })

  it("requires confirmation before deleting a key", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.includes("/api/subscriptions")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 })
        }
        if (
          path.includes("/api/keys/key-production") &&
          init?.method === "DELETE"
        ) {
          return new Response(JSON.stringify({}), { status: 204 })
        }
        return new Response(JSON.stringify({ items: keys }), { status: 200 })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const screen = await render(<UserKeys tenantModels={[]} />)

    await screen.getByRole("button", { name: "更多操作 生产环境" }).click()
    await screen.getByRole("menuitem", { name: "删除密钥" }).click()
    await expect.element(screen.getByText("删除 API Key？")).toBeVisible()
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")
    ).toBe(false)

    await screen.getByRole("button", { name: "取消" }).click()
    await expect
      .element(screen.getByText("删除 API Key？"))
      .not.toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")
    ).toBe(false)

    await screen.getByRole("button", { name: "更多操作 生产环境" }).click()
    await screen.getByRole("menuitem", { name: "删除密钥" }).click()
    await screen.getByRole("button", { name: "删除" }).click()
    await expect
      .poll(() =>
        fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")
      )
      .toBe(true)
  })
})
