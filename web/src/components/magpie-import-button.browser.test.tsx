import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { MagpieImportButton } from "@/components/magpie-import-button"
import { copyText } from "@/lib/clipboard"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}))

const setup = {
  href: "https://usemagpie.ai/import#name=RelayAPI&responses=https%3A%2F%2Frelay.example%2Fv1&key=test-secret",
  name: "RelayAPI · relay.example · 工作",
  base_url: "https://relay.example/v1",
  key: "test-secret",
  protocol: "responses",
  balance_supported: true,
  configure_command:
    "magpie provider set relayapi-relay-example-key-1 compaction=native socket=auto billing=plan",
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe("Magpie setup", () => {
  it("keeps the panel open and offers import, installation and masked manual configuration", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(setup))
    vi.stubGlobal("fetch", fetch)
    const before = window.location.href
    const screen = await render(<MagpieImportButton keyID="key/work" />)
    await screen.getByRole("button", { name: "连接 Magpie" }).click()
    await expect
      .element(screen.getByRole("dialog", { name: "连接 Magpie" }))
      .toBeVisible()
    await expect
      .element(screen.getByRole("link", { name: "导入到 Magpie" }))
      .toHaveAttribute("href", setup.href)
    await expect
      .element(screen.getByRole("link", { name: "导入到 Magpie" }))
      .toHaveAttribute("target", "_blank")
    await expect
      .element(screen.getByRole("link", { name: "安装 Magpie" }))
      .toHaveAttribute("href", "https://usemagpie.ai")
    await expect
      .element(screen.getByRole("textbox", { name: "Responses Base URL" }))
      .toHaveValue(setup.base_url)
    await expect
      .element(screen.getByLabelText("API Key", { exact: true }))
      .toHaveAttribute("type", "password")
    expect(window.location.href).toBe(before)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe("/api/keys/key%2Fwork/magpie")
    await screen
      .getByRole("button", { name: "复制 API Key", exact: true })
      .click()
    expect(copyText).toHaveBeenCalledWith("test-secret")
    await expect
      .element(screen.getByRole("textbox", { name: "Magpie 配置命令" }))
      .toHaveValue(setup.configure_command)
    await screen
      .getByRole("button", { name: "复制 Magpie 配置命令", exact: true })
      .click()
    expect(copyText).toHaveBeenCalledWith(setup.configure_command)
    expect(setup.configure_command).not.toContain(setup.key)
    await expectNoA11yViolations()
  })

  it("checks configuration without generating, then only bills an explicitly selected test", async () => {
    const requests: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/check")) return response(setup)
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        return response({
          models: ["gpt-one", "gpt-two"],
          checks: [
            {
              name: body.generate ? "generation" : "models",
              status: "ok",
              message: body.generate ? "生成成功" : "可读取 2 个模型",
            },
          ],
          ...(body.generate
            ? { model: body.model, request_id: "test-request-1" }
            : {}),
        })
      })
    )
    const screen = await render(<MagpieImportButton keyID="work" />)
    await screen.getByRole("button", { name: "连接 Magpie" }).click()
    await expect
      .element(screen.getByRole("button", { name: "运行生成测试（计费）" }))
      .toBeDisabled()
    expect(requests).toEqual([])
    await screen.getByRole("button", { name: "检查配置", exact: true }).click()
    await expect.element(screen.getByText("可读取 2 个模型")).toBeVisible()
    expect(requests).toEqual([{ generate: false }])
    await screen.getByRole("combobox", { name: "生成测试模型" }).click()
    await screen.getByRole("option", { name: "gpt-two" }).click()
    await screen.getByRole("button", { name: "运行生成测试（计费）" }).click()
    await expect.element(screen.getByText("生成成功")).toBeVisible()
    expect(requests).toEqual([
      { generate: false },
      { generate: true, model: "gpt-two" },
    ])
    await expect
      .element(screen.getByText("test-request-1", { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByRole("link", { name: "调用记录" }))
      .toHaveAttribute("href", "/app/logs")
    await expectNoA11yViolations()
  })

  it("explains local HTTP balance limits and shows a recoverable setup error", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ error: { message: "配置暂不可用" } }, 503)
      )
      .mockResolvedValueOnce(response({ ...setup, balance_supported: false }))
    vi.stubGlobal("fetch", fetch)
    const screen = await render(<MagpieImportButton keyID="local" />)
    await screen.getByRole("button", { name: "连接 Magpie" }).click()
    await expect.element(screen.getByText("配置暂不可用")).toBeVisible()
    await screen.getByRole("button", { name: "重试读取配置" }).click()
    await expect
      .element(screen.getByText(/当前地址可导入调用配置/))
      .toBeVisible()
    await expect
      .element(screen.getByText("配置暂不可用"))
      .not.toBeInTheDocument()
  })

  it("cancels an in-flight check when the dialog closes", async () => {
    let checkSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/check")) return response(setup)
        checkSignal = init?.signal
        return new Promise<Response>((_, reject) => {
          checkSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
      })
    )
    const screen = await render(<MagpieImportButton keyID="work" />)
    await screen.getByRole("button", { name: "连接 Magpie" }).click()
    await screen.getByRole("button", { name: "检查配置", exact: true }).click()
    await expect.poll(() => checkSignal).toBeDefined()
    await screen.getByRole("button", { name: "Close", exact: true }).click()
    expect(checkSignal?.aborted).toBe(true)
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument()
  })
})
