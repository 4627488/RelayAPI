import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { RAIDevices } from "@/components/user/rai-devices"
import type { RAIDevice } from "@/lib/api"
import { expectNoA11yViolations } from "@/test/a11y"

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

afterEach(() => vi.unstubAllGlobals())

describe("rai devices", () => {
  it("shows device information and revokes only after confirmation", async () => {
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
    await expect.element(screen.getByText("Windows / amd64")).toBeVisible()
    await expect.element(screen.getByText("1.2.3")).toBeVisible()
    await expect.element(screen.getByText("尚无调用")).toBeVisible()
    await expectNoA11yViolations()
    await screen.getByRole("button", { name: "撤销 Work-PC 的登录" }).click()
    expect(revoked).toBe(false)
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {}))
    )
    await expectNoA11yViolations()
    await screen.getByRole("button", { name: "确认撤销" }).click()
    await expect
      .element(screen.getByText("已撤销", { exact: true }))
      .toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rai/devices/device-1",
      expect.objectContaining({ method: "DELETE" })
    )
    await expect
      .element(screen.getByRole("button", { name: "撤销 Work-PC 的登录" }))
      .not.toBeInTheDocument()
  })

  it("leaves the device available to retry after revocation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? Response.json(
              { error: { message: "暂时无法撤销" } },
              { status: 500 }
            )
          : Response.json({ items: [device] })
      )
    )
    const screen = await render(<RAIDevices />)
    await screen.getByRole("button", { name: "撤销 Work-PC 的登录" }).click()
    await screen.getByRole("button", { name: "确认撤销" }).click()
    await expect
      .element(screen.getByRole("button", { name: "确认撤销" }))
      .toBeEnabled()
    await expect.element(screen.getByRole("alertdialog")).toBeVisible()
  })

  it("explains an empty device list and links to the guide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [] }))
    )
    const screen = await render(<RAIDevices />)
    await expect.element(screen.getByText("还没有 rai 登录设备")).toBeVisible()
    await expect
      .element(screen.getByRole("link", { name: "查看接入指南" }))
      .toHaveAttribute("href", "/app/guide")
    await expectNoA11yViolations()
  })

  it("shows unknown metadata for older clients without guessing the OS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            { ...device, device_os: "", device_arch: "", rai_version: "" },
          ],
        })
      )
    )
    const screen = await render(<RAIDevices />)
    await expect.element(screen.getByText("系统未上报")).toBeVisible()
    await expect
      .element(screen.getByText("未上报", { exact: true }))
      .toBeVisible()
  })
})
