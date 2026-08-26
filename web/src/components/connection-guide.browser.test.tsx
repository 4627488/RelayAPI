import { describe, expect, it } from "vitest"
import { render } from "vitest-browser-react"

import { ConnectionGuide } from "@/components/connection-guide"
import { expectNoA11yViolations } from "@/test/a11y"

describe("RAI connection guide", () => {
  it("switches between platform-specific install commands accessibly", async () => {
    const screen = await render(<ConnectionGuide />)
    const command = screen.getByRole("textbox", { name: "安装命令" })

    await expect
      .element(command)
      .toHaveValue(expect.stringContaining("curl -fsSL"))
    await screen.getByRole("button", { name: "Windows" }).click()
    await expect.element(command).toHaveValue(expect.stringContaining("irm '"))
    await expectNoA11yViolations()
  })
})
