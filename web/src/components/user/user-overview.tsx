import { OverviewPage } from "@/components/overview-page"
import type { Session } from "@/lib/api"
import type { Page } from "@/lib/routes"
export function UserOverview({
  session,
  onPageChange,
}: {
  session: Session
  onPageChange: (page: Page) => void
}) {
  return <OverviewPage session={session} onPageChange={onPageChange} />
}
