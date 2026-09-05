import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { ConnectAccountDialog } from "@/components/providers/connect-account-dialog"

const { apiMock, deleteRequestMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  deleteRequestMock: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: apiMock, deleteRequest: deleteRequestMock }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const props = {
  reauthAccount: null,
  onOpenChange: vi.fn(),
  onSaved: vi.fn().mockResolvedValue(undefined),
  proxies: [],
}

describe("connect account dialog", () => {
  beforeEach(() => {
    apiMock.mockReset()
    deleteRequestMock.mockReset().mockResolvedValue(undefined)
    props.onOpenChange.mockReset()
  })

  it("cancels an OAuth session if start returns after the dialog was closed", async () => {
    const start = deferred<{
      status: string
      url: string
      state: string
      flow: "device"
    }>()
    apiMock.mockReturnValueOnce(start.promise)
    const screen = await render(<ConnectAccountDialog open {...props} />)

    await screen.getByRole("button", { name: "生成授权链接" }).click()
    await screen.getByRole("button", { name: "取消" }).click()
    start.resolve({
      status: "ok",
      url: "https://auth.example.test",
      state: "late-state",
      flow: "device",
    })

    await expect
      .poll(() => deleteRequestMock)
      .toHaveBeenCalledWith("/api/admin/providers/oauth/sessions/late-state")
  })

  it("explains that discovered models are published automatically for API keys", async () => {
    apiMock.mockResolvedValue({})
    const screen = await render(<ConnectAccountDialog open {...props} />)

    await screen.getByRole("tab", { name: /API Key/ }).click()
    await expect
      .element(screen.getByText(/自动读取上游模型目录并发布/))
      .toBeVisible()
  })

  it("updates an untouched import template but preserves edited JSON", async () => {
    const screen = await render(<ConnectAccountDialog open {...props} />)
    await screen.getByRole("tab", { name: /导入/ }).click()
    const document = screen.getByLabelText("凭据 JSON")
    await expect.element(document).toHaveValue('{\n  "type": "codex"\n}')

    await screen.getByRole("combobox").nth(0).click()
    await screen.getByRole("option", { name: "Kimi" }).click()
    await expect.element(document).toHaveValue('{\n  "type": "kimi"\n}')

    await document.fill('{\n  "type": "kimi",\n  "access_token": "edited"\n}')
    await screen.getByRole("combobox").nth(0).click()
    await screen.getByRole("option", { name: "OpenAI", exact: true }).click()
    await expect
      .element(document)
      .toHaveValue('{\n  "type": "kimi",\n  "access_token": "edited"\n}')
  })
})
