import { useEffect, useState } from "react"

export type Workspace = "user" | "admin"

export type Page =
  | "overview"
  | "usage"
  | "keys"
  | "logs"
  | "guide"
  | "users"
  | "invitations"
  | "providers"
  | "proxies"
  | "settings"
  | "subscriptions"
  | "pricing"

export interface AppRoute {
  workspace: Workspace
  page: Page
  logId?: string
  valid: boolean
}

type RouteLocation = Pick<Location, "pathname" | "hash">

const userPages = new Set<Page>([
  "overview",
  "usage",
  "keys",
  "logs",
  "guide",
  "subscriptions",
])

const adminPages = new Set<Page>([
  "overview",
  "usage",
  "logs",
  "users",
  "invitations",
  "providers",
  "proxies",
  "settings",
  "subscriptions",
  "pricing",
])

const routeChangeEvent = "relayapi:route-change"

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value).trim()
  } catch {
    return ""
  }
}

function legacyLogId(hash: string) {
  if (!hash.startsWith("#log=")) return ""
  const value = safeDecode(hash.slice(5))
  return value.length <= 256 ? value : ""
}

export function parseAppRoute(location: RouteLocation): AppRoute {
  const normalizedPathname =
    location.pathname === "/" ? "/" : location.pathname.replace(/\/+$/, "")
  const segments = location.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(safeDecode)

  const workspace: Workspace = segments[0] === "admin" ? "admin" : "user"
  const pages = workspace === "admin" ? adminPages : userPages
  const offset = segments[0] === "app" || segments[0] === "admin" ? 1 : 0
  const requestedPage = segments[offset] || "overview"
  let page = requestedPage as Page

  if (
    workspace === "admin" &&
    requestedPage === "users" &&
    segments[offset + 1] === "invitations"
  ) {
    page = "invitations"
  } else if (
    workspace === "admin" &&
    requestedPage === "settings" &&
    segments[offset + 1] === "proxies"
  ) {
    page = "proxies"
  }

  const validPrefix =
    segments.length === 0 || segments[0] === "app" || segments[0] === "admin"
  const validPage = pages.has(page)
  const logIndex = offset + 1
  const rawLogId = page === "logs" ? segments[logIndex] : ""
  const logId = rawLogId || (page === "logs" ? legacyLogId(location.hash) : "")

  const candidate = {
    workspace,
    page: validPage ? page : ("overview" as Page),
    logId: logId || undefined,
  }
  return {
    ...candidate,
    valid:
      validPrefix && validPage && normalizedPathname === routeHref(candidate),
  }
}

export function routeHref(route: Omit<AppRoute, "valid">) {
  const base = route.workspace === "admin" ? "/admin" : "/app"
  let path = base

  if (route.page !== "overview") {
    if (route.workspace === "admin" && route.page === "invitations") {
      path += "/users/invitations"
    } else if (route.workspace === "admin" && route.page === "proxies") {
      path += "/settings/proxies"
    } else {
      path += `/${route.page}`
    }
  }

  if (route.page === "logs" && route.logId) {
    path += `/${encodeURIComponent(route.logId)}`
  }
  return path
}

export function navigateTo(
  route: Omit<AppRoute, "valid">,
  options: { replace?: boolean; state?: unknown } = {}
) {
  const href = routeHref(route)
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (href === current) return
  const method = options.replace ? "replaceState" : "pushState"
  window.history[method](options.state ?? null, "", href)
  window.dispatchEvent(new Event(routeChangeEvent))
}

export function useAppRoute() {
  const [route, setRoute] = useState(() => parseAppRoute(window.location))

  useEffect(() => {
    const sync = () => setRoute(parseAppRoute(window.location))
    window.addEventListener("popstate", sync)
    window.addEventListener("hashchange", sync)
    window.addEventListener(routeChangeEvent, sync)
    return () => {
      window.removeEventListener("popstate", sync)
      window.removeEventListener("hashchange", sync)
      window.removeEventListener(routeChangeEvent, sync)
    }
  }, [])

  return route
}
