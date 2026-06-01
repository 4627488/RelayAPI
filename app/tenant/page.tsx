import { cookies } from "next/headers";

import { TenantDashboard } from "@/components/tenant-dashboard";
import { TenantLogin } from "@/components/auth/tenant-login";
import { getAdminOverviewStats, queryRequestLogs } from "@/src/server/repositories/logs";
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
    return <TenantLogin />;
  }

  const tenant = toPublicTenant(session.tenant);
  const requestLogsPage = queryRequestLogs({
    tenantId: session.tenant.id,
    limit: 25,
    offset: 0,
    skipTotal: true,
  });
  const initialNow = new Date().getTime();

  return (
    <TenantDashboard
      initialTenant={tenant}
      initialApiKeys={listTenantApiKeyPublicRecords(session.tenant.id)}
      initialResources={getTenantResources(session.tenant)}
      initialOverviewStats={getAdminOverviewStats({
        tenantId: session.tenant.id,
      })}
      initialRequestLogsPage={{
        object: "list",
        data: requestLogsPage.data,
        limit: requestLogsPage.limit,
        page: 1,
        offset: requestLogsPage.offset,
        total: requestLogsPage.total,
        totalPages: 1,
        summary: {
          errorCount: requestLogsPage.errorCount,
          totalTokens: requestLogsPage.totalTokens,
          cachedTokens: requestLogsPage.cachedTokens,
          cacheHitRate: requestLogsPage.cacheHitRate,
          avgLatencyMs: requestLogsPage.avgLatencyMs,
        },
      }}
      initialNow={initialNow}
    />
  );
}
