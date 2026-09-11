import { beforeEach, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { CodexResetCreditsPanel } from "./codex-reset-credits-panel"
import { api } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))
const details = {
  available_count: 3,
  observed_at: "2026-09-11T00:00:00Z",
  credits: [
    {
      id: "credit-1",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-09-01T00:00:00Z",
      expires_at: "2026-10-01T00:00:00Z",
      title: "每周与 5 小时额度重置",
    },
    {
      id: "credit-2",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: null,
      expires_at: null,
    },
  ],
}
beforeEach(() => {
  vi.mocked(api).mockReset()
  sessionStorage.removeItem("codex-reset-attempt:codex-1")
})
const props = () => ({
  accountID: "codex-1",
  accountName: "研发 Codex",
  disabled: false,
  onConsumed: vi.fn().mockResolvedValue(undefined),
})

it("shows the upstream count and expiry, and only spends after confirmation", async () => {
  const p = props()
  vi.mocked(api).mockImplementation(async (_, init) =>
    init?.method === "POST" ? { code: "reset", windows_reset: 2 } : details
  )
  const screen = await render(<CodexResetCreditsPanel {...p} />)
  await expect
    .element(screen.getByText("可用 3 次", { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByText(/到期于.*10月1日/)).toBeVisible()
  await expect.element(screen.getByText(/未提供到期时间/)).toBeVisible()
  expect(
    vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")
  ).toHaveLength(0)
  await screen
    .getByRole("button", { name: "使用一次重置", exact: true })
    .click()
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished)
  )
  await expectNoA11yViolations()
  await screen.getByRole("button", { name: "取消", exact: true }).click()
  expect(
    vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")
  ).toHaveLength(0)
  await screen
    .getByRole("button", { name: "使用一次重置", exact: true })
    .click()
  await screen.getByRole("button", { name: "确认使用", exact: true }).click()
  await expect
    .element(screen.getByText("已使用一次重置。", { exact: true }))
    .toBeVisible()
  await expect.poll(() => p.onConsumed.mock.calls.length).toBe(1)
  const posts = vi
    .mocked(api)
    .mock.calls.filter(([, init]) => init?.method === "POST")
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body)).redeem_request_id).toMatch(
    /^[0-9a-f-]{36}$/
  )
})

it("keeps the same redemption ID after a timeout and reopening the panel", async () => {
  let posts = 0
  vi.mocked(api).mockImplementation(async (_, init) => {
    if (init?.method !== "POST") return details
    if (++posts === 1) throw new Error("请求超时")
    return { code: "already_redeemed", windows_reset: 2 }
  })
  const first = await render(<CodexResetCreditsPanel {...props()} />)
  await first.getByRole("button", { name: "使用一次重置", exact: true }).click()
  await first.getByRole("button", { name: "确认使用", exact: true }).click()
  await expect
    .element(first.getByText("重置结果待确认", { exact: true }))
    .toBeVisible()
  await first.unmount()
  const second = await render(<CodexResetCreditsPanel {...props()} />)
  await second
    .getByRole("button", { name: "重试确认重置结果", exact: true })
    .click()
  await second.getByRole("button", { name: "确认使用", exact: true }).click()
  await expect
    .element(
      second.getByText("这次重置已完成，没有重复扣除次数。", { exact: true })
    )
    .toBeVisible()
  const requests = vi
    .mocked(api)
    .mock.calls.filter(([, init]) => init?.method === "POST")
  expect(requests).toHaveLength(2)
  expect(requests[0][1]?.body).toBe(requests[1][1]?.body)
  expect(sessionStorage.getItem("codex-reset-attempt:codex-1")).toBeNull()
})

it("does not turn unavailable data into zero resets", async () => {
  vi.mocked(api).mockRejectedValue(
    new Error("Codex banked resets returned HTTP 404")
  )
  const screen = await render(<CodexResetCreditsPanel {...props()} />)
  await expect
    .element(screen.getByText("查询或重置未完成", { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText("可用 0 次", { exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByRole("button", { name: "使用一次重置", exact: true }))
    .toBeDisabled()
})

it("distinguishes zero credits from missing expiry details", async () => {
  vi.mocked(api).mockResolvedValue({
    ...details,
    available_count: 0,
    credits: null,
  })
  const screen = await render(<CodexResetCreditsPanel {...props()} />)
  await expect
    .element(screen.getByText("可用 0 次", { exact: true }))
    .toBeVisible()
  await expect
    .element(
      screen.getByText("上游未提供每次重置的到期明细。", { exact: true })
    )
    .toBeVisible()
  await expect
    .element(screen.getByRole("button", { name: "使用一次重置", exact: true }))
    .toBeDisabled()
})
