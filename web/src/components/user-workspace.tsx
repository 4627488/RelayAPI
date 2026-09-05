import { lazy, Suspense } from "react"

import { LoadingView } from "@/components/loading-view"
import type { Session } from "@/lib/api"
import type { Page } from "@/lib/routes"

const UserOverview = lazy(() =>
  import("@/components/user/user-overview").then((module) => ({
    default: module.UserOverview,
  }))
)
const UserKeys = lazy(() =>
  import("@/components/user/user-keys").then((module) => ({
    default: module.UserKeys,
  }))
)
const UserGuide = lazy(() =>
  import("@/components/user/user-guide").then((module) => ({
    default: module.UserGuide,
  }))
)
const UsageView = lazy(() =>
  import("@/components/usage-view").then((module) => ({
    default: module.UsageView,
  }))
)
const TenantSubscriptionsView = lazy(() =>
  import("@/components/subscriptions-view").then((module) => ({
    default: module.TenantSubscriptionsView,
  }))
)
const RequestLogsWorkbench = lazy(() =>
  import("@/components/request-logs-workbench").then((module) => ({
    default: module.RequestLogsWorkbench,
  }))
)

interface UserWorkspaceProps {
  page: Page
  session: Session
  onPageChange: (page: Page) => void
}

export function UserWorkspace({
  page,
  session,
  onPageChange,
}: UserWorkspaceProps) {
  const tenantModels = session.tenant?.model_allowlist ?? []

  return (
    <Suspense fallback={<LoadingView />}>
      {page === "keys" ? (
        <UserKeys tenantModels={tenantModels} />
      ) : page === "logs" ? (
        <RequestLogsWorkbench />
      ) : page === "guide" ? (
        <UserGuide />
      ) : page === "subscriptions" ? (
        <TenantSubscriptionsView />
      ) : page === "usage" ? (
        <UsageView />
      ) : (
        <UserOverview session={session} onPageChange={onPageChange} />
      )}
    </Suspense>
  )
}
