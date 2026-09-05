import { describe, expect, it } from "vitest"
import { render } from "vitest-browser-react"
import { useState } from "react"

import { ModelSelector } from "@/components/model-selector"

function Harness({ initial = [] }: { initial?: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <ModelSelector
        id="models"
        options={["gpt-5", "claude-3", "gemini-2"]}
        value={value}
        onChange={setValue}
      />
      <output aria-label="selected">{value.join(",") || "all"}</output>
    </>
  )
}

describe("ModelSelector", () => {
  it("does not silently broaden permissions when deselecting the last model", async () => {
    const screen = await render(<Harness initial={["gpt-5"]} />)
    await screen.getByRole("combobox").click()
    await screen.getByRole("option", { name: "gpt-5", exact: true }).click()
    await expect
      .element(screen.getByLabelText("selected"))
      .toHaveTextContent("gpt-5")
  })

  it("searches options and supports keyboard multi-selection while preserving existing values", async () => {
    const screen = await render(<Harness initial={["gpt-5"]} />)
    const input = screen.getByRole("combobox")

    await input.click()
    await input.fill("claude")
    await expect.element(screen.getByText("claude-3")).toBeVisible()
    await expect
      .element(screen.getByRole("option", { name: "gpt-5", exact: true }))
      .not.toBeInTheDocument()
    const inputElement = await input.element()
    inputElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    )
    inputElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
    await expect
      .element(screen.getByLabelText("selected"))
      .toHaveTextContent("gpt-5,claude-3")
  })

  it("maps the explicit all models option to the API empty-list meaning", async () => {
    const screen = await render(<Harness initial={["gpt-5"]} />)
    const input = screen.getByRole("combobox")

    await input.click()
    await expect.element(screen.getByText("全部可用模型")).toBeVisible()
    await screen.getByText("全部可用模型").click()
    await expect
      .element(screen.getByLabelText("selected"))
      .toHaveTextContent("all")
  })
})
