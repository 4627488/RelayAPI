import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"

import { NotificationInbox } from "@/components/notification-inbox"
import { UpdatesPage } from "@/components/updates-page"
import { releases } from "@/lib/releases"
import { useAppRoute } from "@/lib/routes"
import { expectNoA11yViolations } from "@/test/a11y"

const accountId = "release-test"
const storageKey = `relayapi.inbox.v1.${accountId}`

function Workspace() {
  const route = useAppRoute()
  return (
    <main>
      <NotificationInbox accountId={accountId} workspace={route.workspace} />
      {route.page === "updates" ? (
        <UpdatesPage
          accountId={accountId}
          workspace={route.workspace}
          releaseId={route.releaseId}
        />
      ) : (
        <h1>总览</h1>
      )}
    </main>
  )
}

beforeEach(() => {
  localStorage.removeItem(storageKey)
  window.history.replaceState(null, "", "/app")
})
afterEach(() => {
  localStorage.removeItem(storageKey)
  window.history.replaceState(null, "", "/")
})

describe("release inbox", () => {
  it("opens a release, preserves its read receipt on remount and keeps accounts separate", async () => {
    const screen = await render(<Workspace />)
    await screen.getByRole("button", { name: "通知，3 条未读" }).click()
    await expect
      .element(screen.getByRole("heading", { name: "通知信箱" }))
      .toBeVisible()
    await Promise.allSettled(
      document.getAnimations().map((animation) => animation.finished)
    )
    await expectNoA11yViolations(screen.getByRole("dialog").element())
    await screen
      .getByRole("link", { name: new RegExp(releases[1].title) })
      .click()
    expect(window.location.pathname).toBe(`/app/updates/${releases[1].id}`)
    await expect
      .element(screen.getByRole("heading", { name: releases[1].title }))
      .toHaveFocus()
    await expect
      .element(screen.getByRole("button", { name: "通知，2 条未读" }))
      .toBeVisible()
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([
      releases[1].id,
    ])
    await screen.unmount()
    const reloaded = await render(
      <NotificationInbox accountId={accountId} workspace="admin" />
    )
    await expect
      .element(reloaded.getByRole("button", { name: "通知，2 条未读" }))
      .toBeVisible()
    await reloaded.unmount()
    const other = await render(
      <NotificationInbox accountId="another-account" workspace="user" />
    )
    await expect
      .element(other.getByRole("button", { name: "通知，3 条未读" }))
      .toBeVisible()
  })

  it("marks all read without removing messages, and receives cross-tab changes", async () => {
    const screen = await render(
      <NotificationInbox accountId={accountId} workspace="user" />
    )
    await screen.getByRole("button", { name: "通知，3 条未读" }).click()
    await screen.getByRole("button", { name: "全部标为已读" }).click()
    await expect
      .element(screen.getByRole("button", { name: "通知，暂无未读" }))
      .toBeVisible()
    await expect
      .element(
        screen.getByRole("link", { name: new RegExp(releases[0].title) })
      )
      .toBeVisible()
    await expect
      .element(screen.getByRole("button", { name: "全部标为已读" }))
      .toBeDisabled()
    localStorage.removeItem(storageKey)
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }))
    await expect
      .element(screen.getByRole("button", { name: "通知，3 条未读" }))
      .toBeVisible()
  })

  it("recovers from malformed read data and storage write failures", async () => {
    const id = "blocked-storage-test"
    const key = `relayapi.inbox.v1.${id}`
    localStorage.setItem(key, "{invalid")
    const screen = await render(
      <NotificationInbox accountId={id} workspace="user" />
    )
    await screen.getByRole("button", { name: "通知，3 条未读" }).click()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked")
    })
    await screen.getByRole("button", { name: "全部标为已读" }).click()
    await expect
      .element(screen.getByRole("button", { name: "通知，暂无未读" }))
      .toBeVisible()
    localStorage.removeItem(key)
  })

  it("renders Markdown accessibly on mobile and handles unknown releases", async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(
        <main>
          <UpdatesPage
            accountId={accountId}
            workspace="user"
            releaseId="missing"
          />
        </main>
      )
      await expect.element(screen.getByRole("status")).toBeVisible()
      expect(
        screen.container.querySelectorAll("pre code").length
      ).toBeGreaterThan(0)
      expect(screen.container.querySelectorAll("table").length).toBe(2)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        window.innerWidth
      )
      await expectNoA11yViolations()
      document.documentElement.classList.add("dark")
      await Promise.allSettled(
        document.getAnimations().map((animation) => animation.finished)
      )
      await expectNoA11yViolations()
    } finally {
      document.documentElement.classList.remove("dark")
      await page.viewport(1280, 800)
    }
  })
})
