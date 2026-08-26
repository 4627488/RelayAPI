import { describe, expect, it } from "vitest"

import { parseAppRoute, routeHref } from "@/lib/routes"

function location(pathname: string, hash = "") {
  return { pathname, hash } as Pick<Location, "pathname" | "hash">
}

describe("application routes", () => {
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
