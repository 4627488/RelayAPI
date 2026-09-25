import { afterEach, describe, expect, it, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import { TokenHeatmap } from "./token-heatmap"
import { heatmapFixture } from "@/test/heatmap-fixture"
import { expectNoA11yViolations } from "@/test/a11y"

afterEach(async () => {
  vi.unstubAllGlobals()
  document.documentElement.classList.remove("dark")
  await page.viewport(1280, 800)
})

describe("token heatmap", () => {
  it.each([390, 1280])(
    "renders the calendar without page overflow at %s",
    async (width) => {
      await page.viewport(width, 900)
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(heatmapFixture()))
      )
      const screen = await render(
        <main className="p-4">
          <TokenHeatmap />
        </main>
      )
      await expect
        .element(screen.getByText("gpt-5.6-sol", { exact: true }))
        .toBeVisible()
      await expect
        .element(screen.getByRole("button", { name: "开启公开分享" }))
        .toBeVisible()
      expect(document.querySelectorAll(".heatmap-day")).toHaveLength(365)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      expect(
        document.querySelectorAll('.heatmap-day[tabindex="0"]')
      ).toHaveLength(1)
      await expectNoA11yViolations()
      document.documentElement.classList.add("dark")
      await expectNoA11yViolations()
    }
  )

  it("only shares after an explicit action, rotates and revokes the URL", async () => {
    let generation = 0
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return Response.json({
            share_path: `/share/usage/public-${++generation}/heatmap.svg`,
          })
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 })
        return Response.json(heatmapFixture())
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const screen = await render(<TokenHeatmap />)
    await expect
      .element(screen.getByRole("button", { name: "开启公开分享" }))
      .toBeVisible()
    expect(generation).toBe(0)
    await screen.getByRole("button", { name: "开启公开分享" }).click()
    await expect
      .element(screen.getByRole("textbox", { name: "公开 SVG 链接" }))
      .toHaveValue(`${location.origin}/share/usage/public-1/heatmap.svg`)
    await screen.getByRole("button", { name: "重置链接" }).click()
    await expect
      .element(screen.getByRole("textbox", { name: "公开 SVG 链接" }))
      .toHaveValue(`${location.origin}/share/usage/public-2/heatmap.svg`)
    await screen.getByRole("button", { name: "关闭分享" }).click()
    await expect
      .element(screen.getByRole("textbox", { name: "公开 SVG 链接" }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText("公开分享已关闭，原链接已失效。"))
      .toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage/heatmap/share",
      expect.objectContaining({ method: "DELETE" })
    )
  })

  it("keeps a failed revoke recoverable and displays the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? Response.json(
              { error: { message: "暂时无法关闭" } },
              { status: 500 }
            )
          : Response.json({
              ...heatmapFixture(),
              share_path: "/share/usage/existing/heatmap.svg",
            })
      )
    )
    const screen = await render(<TokenHeatmap />)
    await screen.getByRole("button", { name: "关闭分享" }).click()
    await expect.element(screen.getByText("暂时无法关闭")).toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "关闭分享" }))
      .toBeEnabled()
    await expect
      .element(screen.getByRole("textbox", { name: "公开 SVG 链接" }))
      .toBeVisible()
  })

  it("supports keyboard navigation and an empty year", async () => {
    const fixture = heatmapFixture()
    fixture.days = fixture.days.map((day) => ({
      ...day,
      tokens: 0,
      level: 0,
      model: "",
      color: "",
    }))
    fixture.total_tokens = fixture.active_days = fixture.peak_tokens = 0
    fixture.models = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(fixture))
    )
    const screen = await render(<TokenHeatmap />)
    await expect.element(screen.getByText(/还没有 token 消耗/)).toBeVisible()
    await screen
      .getByRole("button", {
        name: "2026-09-26 · 0 tokens · 暂无消耗",
        exact: true,
      })
      .click()
    await userEvent.keyboard("{ArrowLeft}")
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "2026-09-19 · 0 tokens · 暂无消耗"
    )
    await userEvent.keyboard("{Home}")
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "2025-09-27 · 0 tokens · 暂无消耗"
    )
  })
})
