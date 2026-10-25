import { expect, it } from "vitest"
import { render } from "vitest-browser-react"
import {
  AnalyticsSummary,
  AttributionPanel,
  ObservationPanels,
} from "./analytics-panels"
import { analyticsFixture as report } from "@/test/analytics-fixture"
import { expectNoA11yViolations } from "@/test/a11y"

it("uses weighted summary rates and reports retained sample coverage", async () => {
  const screen = await render(
    <main>
      <AnalyticsSummary report={report} />
      <ObservationPanels report={report} />
    </main>
  )
  await expect
    .element(
      screen.getByText(
        "保留 5 / 10 条请求记录；已归档的用量仍计入成本与用量，不补算延迟。"
      )
    )
    .toBeVisible()
  await expect.element(screen.getByText("0 ms", { exact: true })).toBeVisible()
  await expect.element(screen.getByText("quota_exhausted")).toBeVisible()
  expect(screen.getByText("80.0%", { exact: true }).elements()).toHaveLength(2)
  await expectNoA11yViolations()
})
it("sorts and filters all attribution rows without changing the report", async () => {
  const screen = await render(<AttributionPanel report={report} admin />)
  const rows = () => screen.getByRole("row").elements()
  expect(rows()[1].textContent).toContain("expensive-model")
  await screen.getByRole("button", { name: "错误", exact: true }).click()
  expect(rows()[1].textContent).toContain("failing-model")
  await screen.getByRole("textbox", { name: "搜索归因名称" }).fill("expensive")
  expect(rows()).toHaveLength(2)
  expect(report.models[0].model).toBe("expensive-model")
  await screen.getByRole("button", { name: "清除搜索" }).click()
  await screen.getByRole("tab", { name: "提供商", exact: true }).click()
  await expect
    .element(
      screen.getByText("提供商归因仅覆盖保留的请求记录，不含已归档用量。")
    )
    .toBeVisible()
  await expectNoA11yViolations()
})
it("does not present absent observations as healthy zero latency", async () => {
  const empty = {
    ...report,
    summary: {
      ...report.summary,
      requests: 0,
      errors: 0,
      prompt_tokens: 0,
      cached_tokens: 0,
    },
    observability: undefined,
  }
  const screen = await render(
    <main>
      <AnalyticsSummary report={empty} />
      <ObservationPanels report={empty} />
      <AttributionPanel report={report} />
    </main>
  )
  await expect.element(screen.getByText("尚无请求样本")).toBeVisible()
  await expect.element(screen.getByText("性能观测暂不可用")).toBeVisible()
  await expect
    .element(screen.getByRole("tab", { name: "租户", exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByRole("tab", { name: "提供商", exact: true }))
    .not.toBeInTheDocument()
})
