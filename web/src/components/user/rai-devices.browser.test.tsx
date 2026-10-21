import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { RAIDevices } from "@/components/user/rai-devices"
import type { RAIDevice } from "@/lib/api"
import { deviceActivity } from "@/lib/device-activity"
import { expectNoA11yViolations } from "@/test/a11y"

const now = Date.parse("2026-10-22T12:00:00Z")
const device: RAIDevice = {
  id: "device-1",
  device_name: "Work-PC",
  device_os: "windows",
  device_arch: "amd64",
  rai_version: "1.2.3",
  enabled: true,
  expires_at: null,
  last_used_at: null,
  created_at: "2026-09-23T00:00:00Z",
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now))
afterEach(() => vi.unstubAllGlobals())

function mockDevices(items: RAIDevice[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items }))
  )
}

describe("devices", () => {
  it("shows readable device information and removes a device only after confirmed revocation", async () => {
    let revoked = false
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          revoked = true
          return new Response(null, { status: 204 })
        }
        return Response.json({ items: [{ ...device, enabled: !revoked }] })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const screen = await render(<RAIDevices />)
    await expect
      .element(screen.getByRole("heading", { name: "设备", exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText("Windows", { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByText("x64")).toBeVisible()
    await expect.element(screen.getByText("rai 1.2.3")).toBeVisible()
    await expect.element(screen.getByText("尚未使用")).toBeVisible()
    await expectNoA11yViolations()
    await screen.getByRole("button", { name: "取消 Work-PC 的授权" }).click()
    expect(revoked).toBe(false)
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
    await Promise.allSettled(
      document.getAnimations().map((animation) => animation.finished)
    )
    await expectNoA11yViolations()
    await screen.getByRole("button", { name: "保留授权" }).click()
    expect(revoked).toBe(false)
    await screen.getByRole("button", { name: "取消 Work-PC 的授权" }).click()
    await screen.getByRole("button", { name: "确认取消授权" }).click()
    await expect.element(screen.getByText("还没有已授权的设备")).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rai/devices/device-1",
      expect.objectContaining({ method: "DELETE" })
    )
    await expect
      .element(screen.getByText("Work-PC", { exact: true }))
      .not.toBeInTheDocument()
  })

  it("keeps successful revocations hidden even if refreshing the list fails", async () => {
    let revoked = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          revoked = true
          return new Response(null, { status: 204 })
        }
        if (revoked) throw new Error("刷新失败")
        return Response.json({ items: [device] })
      })
    )
    const screen = await render(<RAIDevices />)
    await screen.getByRole("button", { name: "取消 Work-PC 的授权" }).click()
    await screen.getByRole("button", { name: "确认取消授权" }).click()
    await expect.element(screen.getByText("还没有已授权的设备")).toBeVisible()
    await expect
      .element(screen.getByText("Work-PC", { exact: true }))
      .not.toBeInTheDocument()
  })

  it("leaves the device available to retry after revocation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? Response.json(
              { error: { message: "暂时无法取消授权" } },
              { status: 500 }
            )
          : Response.json({ items: [device] })
      )
    )
    const screen = await render(<RAIDevices />)
    await screen.getByRole("button", { name: "取消 Work-PC 的授权" }).click()
    await screen.getByRole("button", { name: "确认取消授权" }).click()
    await expect
      .element(screen.getByRole("button", { name: "确认取消授权" }))
      .toBeEnabled()
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
    await expect
      .element(screen.getByText("Work-PC", { exact: true }))
      .toBeInTheDocument()
  })

  it("filters revoked and expired records and sorts active devices by recent activity", async () => {
    mockDevices([
      { ...device, id: "revoked", device_name: "Revoked-PC", enabled: false },
      {
        ...device,
        id: "expired",
        device_name: "Expired-PC",
        expires_at: new Date(now).toISOString(),
      },
      { ...device, last_used_at: "2026-09-22T12:00:00Z" },
      {
        ...device,
        id: "recent",
        device_name: "MacBook",
        device_os: "darwin",
        last_used_at: new Date(now - 2 * 3600_000).toISOString(),
      },
      {
        ...device,
        id: "management",
        device_name: "Cloud CLI",
        purpose: "account",
      },
    ])
    const screen = await render(<RAIDevices />)
    await expect.element(screen.getByText("1 个月前使用")).toBeVisible()
    await expect.element(screen.getByText("2 小时前使用")).toBeVisible()
    await expect.element(screen.getByText("未记录使用时间")).toBeVisible()
    await expect.element(screen.getByText("Revoked-PC")).not.toBeInTheDocument()
    await expect.element(screen.getByText("Expired-PC")).not.toBeInTheDocument()
    expect(screen.getByRole("listitem").elements()[0].textContent).toContain(
      "MacBook"
    )
    await expect.element(screen.getByLabelText("3 个设备")).toBeVisible()
  })

  it("shows an empty state when only inactive devices remain", async () => {
    mockDevices([{ ...device, enabled: false }])
    const screen = await render(<RAIDevices />)
    await expect.element(screen.getByText("还没有已授权的设备")).toBeVisible()
    await expect
      .element(screen.getByRole("link", { name: "查看接入指南" }))
      .toHaveAttribute("href", "/app/guide")
    await expectNoA11yViolations()
  })

  it("keeps unknown metadata honest and fits narrow screens", async () => {
    await page.viewport(390, 844)
    try {
      mockDevices([
        {
          ...device,
          device_os: "",
          device_arch: "",
          rai_version: "",
          device_name: "very-long-device-name-".repeat(8),
        },
      ])
      const screen = await render(<RAIDevices />)
      await expect.element(screen.getByText("系统未上报")).toBeVisible()
      await expect.element(screen.getByText("rai 版本未上报")).toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        window.innerWidth
      )
      await expectNoA11yViolations()
    } finally {
      await page.viewport(1280, 800)
    }
  })
})

describe("device activity labels", () => {
  it.each([
    [null, "尚未使用"],
    ["invalid", "尚未使用"],
    [new Date(now + 3600_000).toISOString(), "刚刚使用"],
    [new Date(now - 20_000).toISOString(), "刚刚使用"],
    [new Date(now - 120_000).toISOString(), "2 分钟前使用"],
    [new Date(now - 3 * 86400_000).toISOString(), "3 天前使用"],
    [new Date(now - 365 * 86400_000).toISOString(), "1 年前使用"],
  ])("formats %s as %s", (value, expected) => {
    expect(deviceActivity(value, now)).toBe(expected)
  })
})
