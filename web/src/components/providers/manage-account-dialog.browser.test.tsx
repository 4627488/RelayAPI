import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { ManageAccountDialog } from "./manage-account-dialog"
import type { ProviderAccount } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMock,
}))
const account: ProviderAccount = {
  id: "acct-1",
  name: "acct-1",
  label: "生产接口",
  provider: "openai",
  auth_kind: "api_key",
  disabled: false,
  models: ["gpt-a", "gpt-b"],
  base_url: "https://api.example.com/v1",
  custom_header_names: ["X-Tenant"],
  success: 10,
  failed: 2,
}
function props() {
  return {
    account,
    pending: false,
    onOpenChange: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onToggle: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onReauthenticate: vi.fn(),
    onTest: vi.fn(),
    proxies: [],
  }
}

describe("upstream account details", () => {
  it("retains published choices when catalog refresh fails or omits models", async () => {
    const p = props()
    const screen = await render(<ManageAccountDialog {...p} />)
    await screen.getByRole("tab", { name: "模型发布" }).click()
    apiMock.mockRejectedValueOnce(new Error("上游超时"))
    await screen.getByRole("button", { name: "刷新模型目录" }).click()
    await expect.element(screen.getByText("目录刷新未完全成功")).toBeVisible()
    await expect
      .element(screen.getByRole("checkbox", { name: "gpt-a" }))
      .toBeChecked()
    await expect
      .element(screen.getByRole("checkbox", { name: "gpt-b" }))
      .toBeChecked()
    apiMock.mockResolvedValueOnce({ models: ["gpt-c"], source: "upstream" })
    await screen.getByRole("button", { name: "刷新模型目录" }).click()
    await expect
      .element(screen.getByRole("checkbox", { name: "gpt-c" }))
      .not.toBeChecked()
    await expect
      .element(screen.getByRole("checkbox", { name: "gpt-a" }))
      .toBeChecked()
    await expect
      .element(screen.getByRole("button", { name: "保存模型发布" }))
      .toBeDisabled()
    await screen.getByRole("checkbox", { name: "gpt-c" }).click()
    await screen.getByRole("button", { name: "保存模型发布" }).click()
    await expect
      .poll(() => p.onSave.mock.calls[0]?.[1]?.models)
      .toEqual(["gpt-a", "gpt-b", "gpt-c"])
  })
  it("saves connection without rediscovering or resubmitting publication and headers", async () => {
    const p = props()
    apiMock.mockClear()
    const screen = await render(<ManageAccountDialog {...p} />)
    await screen.getByRole("tab", { name: "连接设置" }).click()
    await screen
      .getByRole("textbox", { name: "接口地址" })
      .fill("https://new.example.com/v1")
    await screen.getByRole("button", { name: "保存连接设置" }).click()
    await expect.poll(() => p.onSave.mock.calls.length).toBe(1)
    expect(p.onSave.mock.calls[0][1]).toEqual({
      name: "生产接口",
      proxy_id: "",
      base_url: "https://new.example.com/v1",
    })
    expect(apiMock).not.toHaveBeenCalled()
  })
  it("requires explicit header replacement and rejects duplicate names", async () => {
    const p = props()
    const screen = await render(<ManageAccountDialog {...p} />)
    await screen.getByRole("tab", { name: "凭据", exact: true }).click()
    await screen.getByRole("combobox", { name: "修改方式" }).click()
    await screen.getByRole("option", { name: "整体替换" }).click()
    await screen.getByLabelText("名称 1").fill("X-Tenant")
    await screen.getByLabelText("值 1").fill("new-value")
    await screen.getByRole("button", { name: "添加请求头" }).click()
    await screen.getByLabelText("名称 2").fill("x-tenant")
    await screen.getByLabelText("值 2").fill("duplicate")
    await screen.getByRole("button", { name: "保存凭据" }).click()
    await expect.element(screen.getByRole("alert")).toBeVisible()
    expect(p.onSave).not.toHaveBeenCalled()
    await screen.getByRole("button", { name: "移除请求头 2" }).click()
    await screen.getByRole("button", { name: "保存凭据" }).click()
    await expect.poll(() => p.onSave.mock.calls.length).toBe(1)
    expect(p.onSave.mock.calls[0][1]).toEqual({
      name: "生产接口",
      proxy_id: "",
      headers: { "X-Tenant": "new-value" },
    })
  })
  it("keeps failed edits and asks before abandoning changes", async () => {
    const p = props()
    p.onSave.mockRejectedValue(new Error("连接保存失败"))
    const screen = await render(<ManageAccountDialog {...p} />)
    await expectNoA11yViolations()
    await screen.getByRole("tab", { name: "连接设置" }).click()
    await screen.getByRole("textbox", { name: "账户名称" }).fill("新名称")
    await screen.getByRole("button", { name: "保存连接设置" }).click()
    await expect.element(screen.getByText("连接保存失败")).toBeVisible()
    await expect
      .element(screen.getByRole("textbox", { name: "账户名称" }))
      .toHaveValue("新名称")
    await screen.getByRole("button", { name: "关闭", exact: true }).click()
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
    expect(p.onOpenChange).not.toHaveBeenCalled()
    await screen.getByRole("button", { name: "继续编辑" }).click()
    await expect
      .element(screen.getByRole("textbox", { name: "账户名称" }))
      .toHaveValue("新名称")
  })
})
