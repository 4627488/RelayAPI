import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { AccountSettings } from "@/components/user/account-settings"
import { api, postJSON } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/api", () => ({ api: vi.fn(), postJSON: vi.fn() }))
describe("GitHub account binding", () => {
  it("requires a password, retains errors, and refreshes after unlinking", async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      bound: true,
      login: "octocat",
    })
    vi.mocked(postJSON).mockReset()
    vi.mocked(postJSON).mockRejectedValueOnce(new Error("当前密码不正确"))
    const screen = await render(
      <main>
        <AccountSettings />
      </main>
    )
    const action = screen.getByRole("button", { name: "确认解绑 GitHub" })
    await expect.element(action).toBeDisabled()
    await expectNoA11yViolations()
    await screen.getByLabelText("当前账户密码").fill("password")
    await action.click()
    await expect
      .element(screen.getByText("当前密码不正确", { exact: true }))
      .toBeVisible()
    expect(postJSON).toHaveBeenCalledWith("/api/account/github/unbind", {
      password: "password",
    })
    vi.mocked(api).mockResolvedValue({ enabled: true, bound: false, login: "" })
    vi.mocked(postJSON).mockResolvedValue({ ok: true })
    await action.click()
    await expect
      .element(screen.getByRole("button", { name: "绑定 GitHub", exact: true }))
      .toBeDisabled()
    await expect.element(screen.getByLabelText("当前账户密码")).toHaveValue("")
    await expect
      .element(screen.getByText("尚未绑定 GitHub 账户", { exact: true }))
      .toBeVisible()
  })
  it("shows configuration state without offering an unusable bind action", async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: false,
      bound: false,
      login: "",
    })
    const screen = await render(<AccountSettings />)
    await expect
      .element(screen.getByText("管理员尚未配置 GitHub 登录。"))
      .toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "绑定 GitHub", exact: true }))
      .not.toBeInTheDocument()
  })
})
