import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { AuthPage } from "@/console/auth"
import { expectNoA11yViolations } from "@/test/a11y"

describe("auth page", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        if (url.includes("/api/auth/status")) {
          return Response.json({ setup_required: false })
        }
        return new Response("{}", { status: 404 })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("centers a login card and can switch to invite registration", async () => {
    const screen = await render(<AuthPage onAuthenticated={() => undefined} />)

    await expect
      .element(screen.getByRole("heading", { level: 1, name: "登录" }))
      .toBeVisible()
    await expect
      .element(screen.getByText("使用已有账户进入控制台。"))
      .toBeVisible()

    await screen.getByRole("button", { name: "已有邀请？创建账户" }).click()
    await expect
      .element(screen.getByRole("heading", { level: 1, name: "接受邀请" }))
      .toBeVisible()
    await expect.element(screen.getByLabelText("邀请 Token")).toBeVisible()

    await expectNoA11yViolations()
  })
})
