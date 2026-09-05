import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { AuthPage } from "@/components/auth-page"
import { expectNoA11yViolations } from "@/test/a11y"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubAuthStatus(setupRequired: boolean) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ setup_required: setupRequired }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("authentication page", () => {
  it("shows a focused login panel and preserves invitation mode", async () => {
    const fetchMock = stubAuthStatus(false)
    const screen = await render(<AuthPage onAuthenticated={() => undefined} />)

    await expect
      .element(screen.getByRole("heading", { name: "登录 RelayAPI" }))
      .toBeVisible()
    await expect.element(screen.getByLabelText("邮箱")).toBeVisible()
    await expect.element(screen.getByLabelText("密码")).toBeVisible()
    await screen.getByRole("button", { name: "已有邀请？创建账户" }).click()
    await expect
      .element(screen.getByRole("heading", { name: "接受邀请" }))
      .toBeVisible()
    await expect.element(screen.getByLabelText("邀请 Token")).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/status",
      expect.objectContaining({ credentials: "include" })
    )
    await expectNoA11yViolations()
  })

  it("switches to first-user initialization when setup is required", async () => {
    stubAuthStatus(true)
    const screen = await render(<AuthPage onAuthenticated={() => undefined} />)

    await expect
      .element(screen.getByRole("heading", { name: "初始化 RelayAPI" }))
      .toBeVisible()
    await expect.element(screen.getByLabelText("显示名称")).toBeVisible()
    await expect.element(screen.getByLabelText("邮箱")).toBeVisible()
    await expect.element(screen.getByLabelText("密码")).toBeVisible()
    await expectNoA11yViolations()
  })
})
