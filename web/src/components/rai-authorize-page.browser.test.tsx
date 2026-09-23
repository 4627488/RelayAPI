import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { page } from "vitest/browser"
import { App } from "@/App"
import { expectNoA11yViolations } from "@/test/a11y"

const path = "/rai/authorize/6e36c3f4-3f0c-4234-9729-69e84db99901"
const initialPath = window.location.pathname
const account = {
  role: "tenant",
  is_admin: false,
  tenant: {
    id: "owner",
    owner_email: "owner@example.com",
    must_change_password: false,
  },
}
const authorization = {
  id: "request",
  device_name: "Work-PC",
  device_os: "windows",
  device_arch: "amd64",
  rai_version: "1.2.3",
  status: "pending",
  expires_at: new Date(Date.now() + 600000).toISOString(),
}

afterEach(async () => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", initialPath)
  document.documentElement.classList.remove("dark")
  await page.viewport(1280, 800)
})

function mockFlow(loggedIn = true, status = "pending") {
  window.history.replaceState(null, "", path)
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === "/api/me")
      return loggedIn
        ? Response.json(account)
        : Response.json({ error: { message: "请先登录" } }, { status: 401 })
    if (url === "/api/auth/login") return Response.json(account)
    if (url.endsWith("/approve"))
      return Response.json({ ...authorization, status: "approved" })
    if (url.endsWith("/deny"))
      return Response.json({ ...authorization, status: "denied" })
    if (status === "invalid")
      return Response.json({ error: { message: "授权无效" } }, { status: 404 })
    return Response.json({ ...authorization, status })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("rai authorization", () => {
  it("keeps the authorization URL through login and explicit approval", async () => {
    const fetchMock = mockFlow(false)
    const screen = await render(<App />)
    await expect
      .element(screen.getByRole("heading", { name: "登录以授权 rai" }))
      .toBeVisible()
    await expect.element(screen.getByText("Windows / amd64")).toBeVisible()
    await expectNoA11yViolations()
    await screen.getByLabelText("邮箱").fill("owner@example.com")
    await screen.getByLabelText("密码").fill("password123")
    await screen.getByRole("button", { name: "登录并继续" }).click()
    await expect
      .element(screen.getByRole("button", { name: "批准授权" }))
      .toBeVisible()
    expect(window.location.pathname).toBe(path)
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))
    ).toBe(false)
    await expect
      .element(screen.getByRole("button", { name: "批准授权" }))
      .toBeEnabled()
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {}))
    )
    await expectNoA11yViolations()
    await screen.getByRole("button", { name: "批准授权" }).click()
    await expect
      .element(screen.getByRole("heading", { name: "设备已获授权" }))
      .toBeVisible()
    await expect
      .element(screen.getByRole("link", { name: "管理已登录设备" }))
      .toHaveAttribute("href", "/app/rai-devices")
    await expectNoA11yViolations()
  })

  it("allows an existing session to deny the request", async () => {
    mockFlow()
    const screen = await render(<App />)
    await screen.getByRole("button", { name: "拒绝", exact: true }).click()
    await expect
      .element(screen.getByRole("heading", { name: "已拒绝授权" }))
      .toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "批准授权" }))
      .not.toBeInTheDocument()
  })

  it("fits a narrow screen in dark mode", async () => {
    await page.viewport(375, 812)
    document.documentElement.classList.add("dark")
    mockFlow()
    const screen = await render(<App />)
    await expect
      .element(screen.getByRole("button", { name: "批准授权" }))
      .toBeEnabled()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375)
    await expectNoA11yViolations()
  })

  it.each([
    ["expired", "授权已过期"],
    ["invalid", "授权链接无效"],
    ["consumed", "设备已获授权"],
  ])("renders %s without authorization controls", async (status, title) => {
    mockFlow(false, status)
    const screen = await render(<App />)
    await expect
      .element(screen.getByRole("heading", { name: title }))
      .toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "批准授权" }))
      .not.toBeInTheDocument()
    await expect.element(screen.getByLabelText("密码")).not.toBeInTheDocument()
    await expectNoA11yViolations()
  })
})
