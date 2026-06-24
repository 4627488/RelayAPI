import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminWorkbench } from "@/components/admin-workbench";
import { WebAccessLogin } from "@/components/auth/web-access-login";
import { emptyAdminOverviewStats } from "@/src/server/repositories/logs";
import { listChannels } from "@/src/server/repositories/channels";
import { listCodexCredentials } from "@/src/server/repositories/codexCredentials";
import { listApiKeyPublicRecords } from "@/src/server/services/apiKeys";
import { getPublicGlobalSettings } from "@/src/server/services/settings";
import { listPublicProxyPoolItems } from "@/src/server/services/proxyPool";
import { listTenants } from "@/src/server/repositories/tenants";
import type { AdminOverviewStats } from "@/src/shared/types/entities";
import {
  getTenantSessionFromCookieValue,
  TENANT_SESSION_COOKIE,
} from "@/src/server/services/tenants";
import {
  initializeWebAccessKey,
  isValidWebSessionValue,
  WEB_SESSION_COOKIE,
} from "@/src/server/services/webAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestLogRow = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_type: string;
  stream: number;
  model: string;
  status_code: number;
  latency_ms: number;
  first_token_latency_ms: number | null;
  tenant_id: string | null;
  tenant_name: string | null;
  api_key_prefix: string | null;
  api_key_name: string | null;
  channel_name: string | null;
  credential_email: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  error_code: string | null;
};

export default async function Home() {
  initializeWebAccessKey();
  const cookieStore = await cookies();
  const webSession = cookieStore.get(WEB_SESSION_COOKIE)?.value;
  const tenantSession = getTenantSessionFromCookieValue(
    cookieStore.get(TENANT_SESSION_COOKIE)?.value,
  );
  if (!isValidWebSessionValue(webSession) && tenantSession) {
    redirect("/tenant");
  }
  if (!isValidWebSessionValue(webSession)) {
    return <WebAccessLogin />;
  }

  const apiKeys = listApiKeyPublicRecords();
  const tenantCount = listTenants().length;
  const channels = listChannels();
  const codexCredentialCount = listCodexCredentials().length;
  const proxyPool = listPublicProxyPoolItems();
  const overviewStats = emptyAdminOverviewStats() as AdminOverviewStats;
  const globalSettings = getPublicGlobalSettings();
  const initialNow = new Date().getTime();

  return (
    <AdminWorkbench
      initialApiKeys={apiKeys}
      initialTenants={[]}
      initialChannels={[]}
      initialCredentials={[]}
      initialProxyPool={proxyPool}
      initialRequestLogsPage={{
        object: "list",
        data: [] as RequestLogRow[],
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
      initialOverviewStats={overviewStats}
      initialGlobalSettings={globalSettings}
      initialLoadedData={{
        apiKeys: false,
        tenants: false,
        credentials: false,
        proxyPool: true,
        channels: false,
        settings: true,
        logs: false,
      }}
      initialResourceCounts={{
        apiKeys: apiKeys.length,
        enabledApiKeys: apiKeys.filter((key) => key.enabled).length,
        channels: channels.length,
        enabledChannels: channels.filter((channel) => channel.enabled).length,
        healthyChannels: channels.filter(
          (channel) => channel.status === "healthy",
        ).length,
        credentials: codexCredentialCount,
        proxyPool: proxyPool.length,
        tenants: tenantCount,
      }}
      initialNow={initialNow}
    />
  );
}
