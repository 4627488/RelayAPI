import { describe, expect, it } from "vitest"

import { parseAppRoute, routeHref } from "@/lib/routes"

function location(pathname: string, hash = "") {
  return { pathname, hash } as Pick<Location, "pathname" | "hash">
}

describe("application routes", () => {
  it.each(["user", "admin"] as const)(
    "round trips release links in %s",
    (workspace) => {
      const route = {
        workspace,
        page: "updates" as const,
        releaseId: "2026-10-21-rai",
      }
      expect(parseAppRoute(location(routeHref(route)))).toMatchObject({
        ...route,
        valid: true,
      })
      expect(parseAppRoute(location(`${routeHref(route)}/extra`)).valid).toBe(
        false
      )
    }
  )
  it("supports the personal model catalog and subscription section links", () => {
    expect(routeHref({ workspace: "user", page: "models" })).toBe("/app/models")
    expect(parseAppRoute(location("/app/models"))).toMatchObject({
      workspace: "user",
      page: "models",
      valid: true,
    })
    expect(
      parseAppRoute(location("/app/subscriptions", "#subscription-shared"))
    ).toMatchObject({ page: "subscriptions", valid: true })
    expect(parseAppRoute(location("/admin/models"))).toMatchObject({
      page: "overview",
      valid: false,
    })
  })
  it("canonicalizes admin allocations into accounts while keeping user subscriptions", () => {
    expect(parseAppRoute(location("/admin/subscriptions"))).toMatchObject({
      workspace: "admin",
      page: "providers",
      valid: false,
    })
    expect(routeHref({ workspace: "admin", page: "subscriptions" })).toBe(
      "/admin/providers"
    )
    expect(parseAppRoute(location("/app/subscriptions"))).toMatchObject({
      page: "subscriptions",
      valid: true,
    })
  })
  it("parses canonical user and admin pages", () => {
    expect(parseAppRoute(location("/app/usage"))).toMatchObject({
      workspace: "user",
      page: "usage",
      valid: true,
    })
    expect(parseAppRoute(location("/admin/users/invitations"))).toMatchObject({
      workspace: "admin",
      page: "invitations",
      valid: true,
    })
    expect(parseAppRoute(location("/admin/settings/proxies"))).toMatchObject({
      workspace: "admin",
      page: "proxies",
      valid: true,
    })
  })

  it("round trips log detail paths", () => {
    const href = routeHref({
      workspace: "admin",
      page: "logs",
      logId: "request/with spaces",
    })
    expect(href).toBe("/admin/logs/request%2Fwith%20spaces")
    expect(parseAppRoute(location(href))).toMatchObject({
      workspace: "admin",
      page: "logs",
      logId: "request/with spaces",
      valid: true,
    })
  })

  it("recognizes legacy log hashes and marks them for canonicalization", () => {
    expect(parseAppRoute(location("/app/logs", "#log=req%201"))).toMatchObject({
      workspace: "user",
      page: "logs",
      logId: "req 1",
      valid: false,
    })
  })

  it("falls back safely for unknown pages", () => {
    expect(parseAppRoute(location("/admin/not-a-page"))).toMatchObject({
      workspace: "admin",
      page: "overview",
      valid: false,
    })
  })
})
