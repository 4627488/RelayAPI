import { describe, expect, it, vi } from "vitest"
import { page as browserPage } from "vitest/browser"
import { render } from "vitest-browser-react"

import { AppShell } from "@/components/app-shell"
import { ThemeProvider } from "@/components/theme-provider"
import type { Session } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

const session: Session = {
  role: "tenant",
  is_admin: true,
  tenant: {
    id: "tenant-1",
    name: "测试用户",
    owner_email: "owner@example.com",
    enabled: true,
    is_admin: true,
    must_change_password: false,
    balance_nano_usd: 0,
    rate_limit_per_minute: null,
    token_limit_daily: null,
    model_allowlist: [],
    created_at: "2026-01-01T00:00:00Z",
  },
}

describe("application shell", () => {
  it("uses real links while keeping client-side navigation accessible", async () => {
    const onPageChange = vi.fn()
    const onWorkspaceChange = vi.fn()
    const screen = await render(
      <ThemeProvider defaultTheme="light" disableTransitionOnChange={false}>
        <AppShell
          session={session}
          workspace="user"
          page="overview"
          onPageChange={onPageChange}
          onWorkspaceChange={onWorkspaceChange}
          onLogout={() => undefined}
        >
          <h1>总览</h1>
        </AppShell>
      </ThemeProvider>
    )

    const logsLink = screen.getByRole("link", { name: "请求日志" })
    await expect.element(logsLink).toHaveAttribute("href", "/app/logs")
    await expect
      .element(screen.getByRole("link", { name: "总览" }))
      .toHaveAttribute("aria-current", "page")
    await expect
      .element(screen.getByRole("link", { name: "跳到主内容" }))
      .toHaveAttribute("href", "#main-content")
    await logsLink.click()
    expect(onPageChange).toHaveBeenCalledWith("logs")

    await screen.getByRole("button", { name: "进入管理员面板" }).click()
    expect(onWorkspaceChange).toHaveBeenCalledWith("admin")
    await expectNoA11yViolations()
  })

  it("closes the navigation sheet after a mobile route selection", async () => {
    const onPageChange = vi.fn()
    await browserPage.viewport(390, 844)
    try {
      const screen = await render(
        <ThemeProvider defaultTheme="light" disableTransitionOnChange={false}>
          <AppShell
            session={session}
            workspace="user"
            page="overview"
            onPageChange={onPageChange}
            onWorkspaceChange={() => undefined}
            onLogout={() => undefined}
          >
            <h1>总览</h1>
          </AppShell>
        </ThemeProvider>
      )

      await screen.getByRole("button", { name: "Toggle Sidebar" }).click()
      const navigationSheet = screen.getByRole("dialog")
      await expect.element(navigationSheet).toBeVisible()
      await screen.getByRole("link", { name: "请求日志" }).click()
      expect(onPageChange).toHaveBeenCalledWith("logs")
      await expect.element(navigationSheet).not.toBeInTheDocument()
    } finally {
      await browserPage.viewport(1280, 800)
    }
  })
})
