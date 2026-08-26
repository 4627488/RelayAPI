import { InfoIcon } from "lucide-react"
import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import {
  InfoBar,
  PageHeader,
  SearchField,
  StatStrip,
} from "@/components/workspace-ui"
import { expectNoA11yViolations } from "@/test/a11y"

describe("workspace UI contract", () => {
  it("renders one clear page heading and accessible shared states", async () => {
    const onClear = vi.fn()
    const screen = await render(
      <main>
        <PageHeader title="请求日志" />
        <SearchField
          value="gpt"
          onChange={() => undefined}
          onClear={onClear}
          placeholder="搜索请求"
        />
        <StatStrip items={[{ label: "请求", value: "128" }]} />
        <InfoBar icon={InfoIcon}>数据每分钟更新一次。</InfoBar>
      </main>
    )

    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("请求日志")
    await screen.getByRole("button", { name: "清除搜索" }).click()
    expect(onClear).toHaveBeenCalledOnce()
    await expectNoA11yViolations()
  })
})
