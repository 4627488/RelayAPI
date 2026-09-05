import type { Page } from "@/lib/routes"
import type { Session } from "@/lib/api"
import { AdminOverviewPage } from "@/console/pages/admin-overview"
import { AdminPricingPage } from "@/console/pages/admin-pricing"
import { AdminProvidersPage } from "@/console/pages/admin-providers"
import { AdminSettingsPage } from "@/console/pages/admin-settings"
import { AdminSubscriptionsPage } from "@/console/pages/admin-subscriptions"
import { AdminUsersPage } from "@/console/pages/admin-users"
import { GuidePage } from "@/console/pages/guide"
import { KeysPage } from "@/console/pages/keys"
import { LogsPage } from "@/console/pages/logs"
import { UserOverviewPage } from "@/console/pages/overview"
import { TenantSubscriptionsPage } from "@/console/pages/subscriptions"
import { UsagePage } from "@/console/pages/usage"

export function Workspace({
  session,
  page,
  logId,
  admin,
  onPageChange,
}: {
  session: Session
  page: Page
  logId?: string
  admin: boolean
  onPageChange: (page: Page, logId?: string) => void
}) {
  if (admin) {
    if (page === "users" || page === "invitations") {
      return <AdminUsersPage currentUserId={session.tenant.id} />
    }
    if (page === "providers") return <AdminProvidersPage />
    if (page === "subscriptions") return <AdminSubscriptionsPage />
    if (page === "pricing") return <AdminPricingPage />
    if (page === "settings" || page === "proxies") return <AdminSettingsPage />
    if (page === "usage") return <UsagePage admin />
    if (page === "logs") {
      return (
        <LogsPage
          admin
          selectedId={logId}
          onSelect={(id) => onPageChange("logs", id)}
        />
      )
    }
    return <AdminOverviewPage />
  }

  if (page === "keys") return <KeysPage />
  if (page === "logs") {
    return (
      <LogsPage
        selectedId={logId}
        onSelect={(id) => onPageChange("logs", id)}
      />
    )
  }
  if (page === "guide") return <GuidePage />
  if (page === "subscriptions") return <TenantSubscriptionsPage />
  if (page === "usage") return <UsagePage />
  return (
    <UserOverviewPage
      session={session}
      onOpenLogs={() => onPageChange("logs")}
    />
  )
}
