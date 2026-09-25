import { OverviewPage } from "@/components/overview-page"
import type { Page } from "@/lib/routes"
export function AdminOverviewPage({
  onPageChange,
}: {
  onPageChange: (page: Page) => void
}) {
  return <OverviewPage admin onPageChange={onPageChange} />
}
