import axe from "axe-core"
import { expect } from "vitest"

export async function expectNoA11yViolations(root: Element = document.body) {
  // Fading dialogs briefly change the effective foreground/background
  // contrast. Audit the settled UI; don't wait on infinite loading spinners.
  await Promise.all(
    root
      .getAnimations({ subtree: true })
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity
      )
      .map((animation) => animation.finished.catch(() => {}))
  )
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
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
      details: violation.nodes.map((node) => node.failureSummary),
    }))
  ).toEqual([])
}
