import { lazy } from "react"

import type { Page } from "@/lib/routes"

const UsersHub = lazy(() =>
  import("@/components/admin/users-hub").then((module) => ({
    default: module.UsersHub,
  }))
)
const AdminOverviewPage = lazy(() =>
  import("@/components/admin/admin-overview-page").then((module) => ({
    default: module.AdminOverviewPage,
  }))
)
const SettingsHub = lazy(() =>
  import("@/components/admin/settings-hub").then((module) => ({
    default: module.SettingsHub,
  }))
)
const ProvidersView = lazy(() =>
  import("@/components/providers-view").then((module) => ({
    default: module.ProvidersView,
  }))
)
const UsageView = lazy(() =>
  import("@/components/usage-view").then((module) => ({
    default: module.UsageView,
  }))
)
const PricingView = lazy(() =>
  import("@/components/pricing-view").then((module) => ({
    default: module.PricingView,
  }))
)
const RequestLogsWorkbench = lazy(() =>
  import("@/components/request-logs-workbench").then((module) => ({
    default: module.RequestLogsWorkbench,
  }))
)
const AdminSubscriptionsView = lazy(() =>
  import("@/components/admin-subscriptions-view").then((module) => ({
    default: module.AdminSubscriptionsView,
  }))
)

interface AdminWorkspaceProps {
  page: Page
  currentUserId: string
  onPageChange: (page: Page) => void
}

export function AdminWorkspace({
  page,
  currentUserId,
  onPageChange,
}: AdminWorkspaceProps) {
  if (page === "users" || page === "invitations") {
    return (
      <UsersHub
        currentUserId={currentUserId}
        tab={page === "invitations" ? "invites" : "accounts"}
        onTabChange={(value) =>
          onPageChange(value === "invites" ? "invitations" : "users")
        }
      />
    )
  }
  if (page === "providers") return <ProvidersView />
  if (page === "settings" || page === "proxies") {
    return (
      <SettingsHub
        tab={page === "proxies" ? "proxies" : "runtime"}
        onTabChange={(value) =>
          onPageChange(value === "proxies" ? "proxies" : "settings")
        }
      />
    )
  }
  if (page === "subscriptions") return <AdminSubscriptionsView />
  if (page === "logs") return <RequestLogsWorkbench admin />
  if (page === "pricing") return <PricingView />
  if (page === "usage") return <UsageView admin />
  return <AdminOverviewPage onPageChange={onPageChange} />
}
