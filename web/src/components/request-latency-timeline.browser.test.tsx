import { expect, it } from "vitest"
import { render } from "vitest-browser-react"
import { RequestLatencyTimeline } from "./request-latency-timeline"

it("shows measured intervals without synthesizing additive attribution", async () => {
  const screen = await render(
    <RequestLatencyTimeline
      totalMS={10}
      stream
      value={JSON.stringify({
        version: 5,
        total_ms: 10,
        segments: [
          {
            id: "runtime",
            label: "运行时执行",
            start_ms: 0.375,
            duration_ms: 9.625,
          },
          { id: "billing", label: "计费处理", start_ms: 10, duration_ms: 25 },
        ],
        marks: [{ id: "first_byte", label: "首个响应事件", offset_ms: 1.125 }],
      })}
    />
  )
  await expect.element(screen.getByText("计费块耗时 · 10 ms")).toBeVisible()
  await expect.element(screen.getByText("0.375 ms")).toBeVisible()
  await expect.element(screen.getByText("25 ms", { exact: true })).toBeVisible()
  expect(document.body.innerText).not.toContain("观测累计")
})

it.each([
  "{}",
  "invalid",
  JSON.stringify({ version: 4, total_ms: 99, segments: [] }),
])(
  "does not fabricate new telemetry for old or absent data: %s",
  async (value) => {
    const screen = await render(
      <RequestLatencyTimeline totalMS={99} stream={false} value={value} />
    )
    await expect
      .element(
        screen.getByText("历史记录未采集新的计费块观测点，仅保留原始总耗时。")
      )
      .toBeVisible()
  }
)
