import axe from "axe-core"
import { expect } from "vitest"

export async function expectNoA11yViolations(root: Element = document.body) {
  const result = await axe.run(root, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
    },
  })

  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }))
  ).toEqual([])
}
