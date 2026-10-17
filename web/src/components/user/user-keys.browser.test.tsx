import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { userEvent } from "vitest/browser"

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
      const body = path.includes("/api/models")
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
  it("defaults to dynamic all-model access even when the model catalog loads later", async () => {
    let resolveCatalog!: (response: Response) => void
    const catalog = new Promise<Response>((resolve) => {
      resolveCatalog = resolve
    })
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/models") return catalog
        if (init?.method === "POST") {
          submitted = JSON.parse(String(init.body))
          return new Response(
            JSON.stringify({ item: keys[0], key: "test-key" }),
            { status: 201 }
          )
        }
        return new Response(JSON.stringify({ items: keys }), { status: 200 })
      })
    )
    const screen = await render(<UserKeys />)
    await screen.getByRole("button", { name: "创建密钥", exact: true }).click()
    await screen
      .getByRole("textbox", { name: "名称", exact: true })
      .fill("继承所有模型")
    resolveCatalog(
      new Response(
        JSON.stringify({
          items: [{ id: "balance-model" }, { id: "subscription-model" }],
        }),
        { status: 200 }
      )
    )
    await screen.getByRole("combobox", { name: "全部可用模型" }).click()
    await expect
      .element(
        screen.getByRole("option", { name: "subscription-model", exact: true })
      )
      .toBeVisible()
    await expect
      .element(
        screen.getByRole("option", { name: "全部可用模型", exact: true })
      )
      .toHaveAttribute("aria-selected", "true")
    await userEvent.keyboard("{Escape}")
    await screen.getByRole("button", { name: "创建", exact: true }).click()
    await expect.poll(() => submitted?.modelAllowlist).toEqual([])
  })

  it("saves an explicit model choice and keeps existing key restrictions", async () => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/models")
          return new Response(
            JSON.stringify({
              items: [{ id: "balance-model" }, { id: "subscription-model" }],
            }),
            { status: 200 }
          )
        if (init?.method === "POST" || init?.method === "PUT") {
          submitted = JSON.parse(String(init.body))
          return new Response(
            JSON.stringify({ item: keys[0], key: "test-key" }),
            { status: 200 }
          )
        }
        return new Response(JSON.stringify({ items: keys }), { status: 200 })
      })
    )
    const screen = await render(<UserKeys />)
    await screen.getByRole("button", { name: "创建密钥", exact: true }).click()
    await screen
      .getByRole("textbox", { name: "名称", exact: true })
      .fill("限定模型")
    await screen.getByRole("combobox", { name: "全部可用模型" }).click()
    await screen
      .getByRole("option", { name: "subscription-model", exact: true })
      .click()
    await userEvent.keyboard("{Escape}")
    await screen.getByRole("button", { name: "创建", exact: true }).click()
    await expect
      .poll(() => submitted?.modelAllowlist)
      .toEqual(["subscription-model"])
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument()
    await screen
      .getByRole("button", { name: "编辑 生产环境", exact: true })
      .click()
    await screen.getByRole("button", { name: "保存", exact: true }).click()
    await expect.poll(() => submitted?.modelAllowlist).toEqual(["gpt-5"])
  })
  it("filters by status and clears a search without confusing no matches with no keys", async () => {
    mockKeys(keys)
    const screen = await render(<UserKeys />)

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
    const screen = await render(<UserKeys />)

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
        if (path.includes("/api/models")) {
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
    const screen = await render(<UserKeys />)

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
