import { afterEach, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { App } from "@/App"
import { expectNoA11yViolations } from "@/test/a11y"

const originalPath = window.location.pathname
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", originalPath)
})

it("resolves a device code and requires explicit approval", async () => {
  window.history.replaceState(null, "", "/rai/authorize")
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "/api/me")
        return Response.json({
          role: "tenant",
          is_admin: false,
          tenant: {
            id: "owner",
            owner_email: "owner@example.com",
            must_change_password: false,
          },
        })
      if (url === "/api/rai/device/resolve") {
        expect(JSON.parse(String(init?.body))).toEqual({
          user_code: "ABCD-EFGH",
        })
        return Response.json({ authorization_id: "request" })
      }
      return Response.json({
        id: "request",
        device_name: "my-server",
        device_os: "linux",
        device_arch: "amd64",
        status: url.endsWith("/approve") ? "approved" : "pending",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      })
    }
  )
  vi.stubGlobal("fetch", fetchMock)
  const screen = await render(<App />)
  await screen.getByLabelText("设备验证码").fill("ABCD-EFGH")
  await expectNoA11yViolations()
  await screen.getByRole("button", { name: "继续", exact: true }).click()
  await expect
    .element(screen.getByText("my-server", { exact: true }))
    .toBeVisible()
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))
  ).toBe(false)
  await screen.getByRole("button", { name: "批准授权" }).click()
  await expect
    .element(screen.getByRole("heading", { name: "设备已获授权" }))
    .toBeVisible()
})

it("keeps invalid codes on the entry screen for retry", async () => {
  window.history.replaceState(null, "", "/rai/authorize")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/me"
        ? Response.json({
            role: "tenant",
            is_admin: false,
            tenant: { id: "owner", must_change_password: false },
          })
        : Response.json(
            { error: { message: "验证码无效或已过期" } },
            { status: 404 }
          )
    )
  )
  const screen = await render(<App />)
  await screen.getByLabelText("设备验证码").fill("AAAA-AAAA")
  await screen.getByRole("button", { name: "继续", exact: true }).click()
  await expect
    .element(screen.getByText("验证码无效或已过期", { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByLabelText("设备验证码")).toBeEnabled()
})
