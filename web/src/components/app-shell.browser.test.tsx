import { describe, expect, it, vi } from "vitest"
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

    const logsLink = screen.getByRole("link", { name: "请求日志" })
    await expect.element(logsLink).toHaveAttribute("href", "/app/logs")
    await logsLink.click()
    expect(onPageChange).toHaveBeenCalledWith("logs")
    await expectNoA11yViolations()
  })
})
