import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { TestAccountDialog } from "@/components/providers/test-account-dialog"
import type { ProviderAccountTestResult } from "@/lib/api"

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: apiMock }
})

const account = {
  id: "account-1",
  name: "主账户",
  provider: "openai",
  auth_kind: "api_key" as const,
  source: "api_key" as const,
  disabled: false,
  models: ["gpt-4.1"],
}

function result(ok: boolean): ProviderAccountTestResult {
  return {
    ok,
    model: "gpt-4.1",
    provider: "openai",
    status_code: ok ? 200 : 500,
    latency_ms: ok ? 120 : 0,
    error: ok ? undefined : "上游错误",
  }
}

describe("test account dialog", () => {
  beforeEach(() => apiMock.mockReset())

  it("aborts a pending test on close and ignores the late response", async () => {
    let resolve!: (value: ProviderAccountTestResult) => void
    apiMock.mockReturnValueOnce(
      new Promise<ProviderAccountTestResult>((next) => {
        resolve = next
      })
    )
    const onResult = vi.fn()
    const onOpenChange = vi.fn()
    const screen = await render(
      <TestAccountDialog
        account={account}
        onOpenChange={onOpenChange}
        onResult={onResult}
      />
    )

    await screen.getByRole("button", { name: "发送测试" }).click()
    await screen.getByRole("button", { name: "关闭" }).click()
    resolve(result(true))

    await expect.poll(() => onOpenChange).toHaveBeenCalledWith(false)
    await expect.poll(() => onResult).not.toHaveBeenCalled()
  })

  it("keeps a failed result available for retry", async () => {
    apiMock
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValueOnce(result(true))
    const onResult = vi.fn()
    const screen = await render(
      <TestAccountDialog
        account={account}
        onOpenChange={vi.fn()}
        onResult={onResult}
      />
    )

    await screen.getByRole("button", { name: "发送测试" }).click()
    await expect.element(screen.getByText("失败")).toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "再测一次" }))
      .toBeVisible()
    await screen.getByRole("button", { name: "再测一次" }).click()
    await expect.element(screen.getByText("通过")).toBeVisible()
    expect(onResult).toHaveBeenCalledTimes(2)
  })
})
