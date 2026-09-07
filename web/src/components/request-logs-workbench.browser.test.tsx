import { afterEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { RequestLogsWorkbench } from "@/components/request-logs-workbench"
import { api, type RequestLog } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))

const log = {
  id: "request-1",
  api_key_id: "key-1",
  api_key_name: "工作电脑的编程工具专用Key".repeat(4),
  api_key_prefix: "sk-relay-1234",
  tenant_name: "管理员看到的用户名称".repeat(4),
  model: "very-long-model-name-".repeat(8),
  method: "POST",
  path: "/v1/responses",
  started_at: "2026-09-07T10:20:30Z",
  status_code: 200,
  client_name: "测试客户端",
  total_tokens: 12500,
  prompt_tokens: 10000,
  completion_tokens: 2500,
  cached_tokens: 8000,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  latency_ms: 12500,
  ttft_ms: 250,
  cost_nano_usd: 1250000,
  request_body_bytes: 1024,
  response_body_bytes: 2048,
} as RequestLog

function setup(admin: boolean) {
  window.history.replaceState(null, "", admin ? "/admin/logs" : "/app/logs")
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith("/request-1")) return { log, detail: null }
    return {
      items: [log],
      total: 1,
      page: 1,
      page_size: 50,
      summary: {
        requests: 1,
        errors: 0,
        tokens: 12500,
        prompt_tokens: 10000,
        cached_tokens: 8000,
        cost_nano_usd: 1250000,
        latency_p50_ms: 12500,
        latency_p95_ms: 12500,
      },
    }
  })
}

afterEach(async () => {
  await page.viewport(1280, 800)
  vi.mocked(api).mockClear()
})

describe("responsive request logs", () => {
  it.each([
    { admin: false, width: 320 },
    { admin: true, width: 820 },
    { admin: false, width: 390 },
    { admin: true, width: 390 },
    { admin: false, width: 1280 },
    { admin: true, width: 1280 },
  ])(
    "shows key identity and opens details at $width (admin=$admin)",
    async ({ admin, width }) => {
      await page.viewport(width, 850)
      setup(admin)
      const screen = await render(
        <main className="mx-auto min-w-0 p-4">
          <RequestLogsWorkbench admin={admin} />
        </main>
      )
      const entry = screen.getByRole("link", { name: /查看日志/ })
      await expect.element(entry).toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      expect(document.body.innerText).toContain("sk-relay-1234")
      if (admin) expect(document.body.innerText).toContain(log.tenant_name)
      await expectNoA11yViolations()
      await screen.getByRole("button", { name: "筛选", exact: true }).click()
      await expect.element(screen.getByLabelText("开始时间")).toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await entry.click()
      await expect
        .element(screen.getByText("Key 名称", { exact: true }))
        .toBeVisible()
      await expect
        .element(screen.getByText(log.api_key_name!, { exact: true }))
        .toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
    }
  )

  it("sends the key filter and clears it without expanding advanced filters", async () => {
    setup(false)
    const screen = await render(<RequestLogsWorkbench />)
    await screen.getByRole("textbox", { name: "筛选 Key" }).fill("工作电脑")
    await expect
      .poll(() =>
        vi
          .mocked(api)
          .mock.calls.some(
            ([path]) =>
              new URL(path, location.origin).searchParams.get("api_key") ===
              "工作电脑"
          )
      )
      .toBe(true)
    await screen.getByRole("button", { name: "清除全部筛选" }).click()
    await expect
      .element(screen.getByRole("textbox", { name: "筛选 Key" }))
      .toHaveValue("")
    await expect
      .poll(() =>
        new URL(
          vi.mocked(api).mock.calls.at(-1)![0],
          location.origin
        ).searchParams.has("api_key")
      )
      .toBe(false)
  })
})
