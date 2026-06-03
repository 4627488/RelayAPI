import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TenantDashboard } from "@/components/tenant-dashboard";
import { emptyAdminOverviewStats } from "@/src/server/repositories/logs";
import { listTenantApiKeyPublicRecords } from "@/src/server/services/apiKeys";
import {
  getTenantResources,
  getTenantSessionFromCookieValue,
  TENANT_SESSION_COOKIE,
  toPublicTenant,
} from "@/src/server/services/tenants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function TenantPage() {
  const cookieStore = await cookies();
  const session = getTenantSessionFromCookieValue(
    cookieStore.get(TENANT_SESSION_COOKIE)?.value,
  );
  if (!session) {
    redirect("/");
  }

  const tenant = toPublicTenant(session.tenant);
  const initialNow = new Date().getTime();

  return (
    <TenantDashboard
      initialTenant={tenant}
      initialApiKeys={listTenantApiKeyPublicRecords(session.tenant.id)}
      initialResources={getTenantResources(session.tenant)}
      initialOverviewStats={emptyAdminOverviewStats()}
      initialRequestLogsPage={{
        object: "list",
        data: [],
        limit: 25,
        page: 1,
        offset: 0,
        total: 0,
        totalPages: 1,
        summary: {
          errorCount: 0,
          totalTokens: 0,
          cachedTokens: 0,
          cacheHitRate: 0,
          avgLatencyMs: 0,
        },
      }}
      initialNow={initialNow}
    />
  );
}
