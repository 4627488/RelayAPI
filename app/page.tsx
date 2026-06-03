import { cookies } from "next/headers";

import { AdminDashboard } from "@/components/admin-dashboard";
import { WebAccessLogin } from "@/components/auth/web-access-login";
import {
  getAdminOverviewStats,
  queryRequestLogs,
} from "@/src/server/repositories/logs";
import { listApiKeyPublicRecords } from "@/src/server/services/apiKeys";
import { listChannelRecords } from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { getPublicGlobalSettings } from "@/src/server/services/settings";
import { listPublicProxyPoolItems } from "@/src/server/services/proxyPool";
import { listPublicTenants } from "@/src/server/services/tenants";
import type { AdminOverviewStats } from "@/src/shared/types/entities";
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
  if (!isValidWebSessionValue(webSession)) {
    return <WebAccessLogin />;
  }

  const apiKeys = listApiKeyPublicRecords();
  const tenants = listPublicTenants();
  const channels = listChannelRecords();
  const codexCredentials = await listPublicCodexCredentials();
  const proxyPool = listPublicProxyPoolItems();
  const overviewStats = getAdminOverviewStats() as AdminOverviewStats;
  const globalSettings = getPublicGlobalSettings();
  const requestLogsPage = queryRequestLogs({
    limit: 25,
    offset: 0,
  });
  const initialNow = new Date().getTime();

  return (
    <AdminDashboard
      initialApiKeys={apiKeys}
      initialTenants={tenants}
      initialChannels={channels}
      initialCredentials={codexCredentials}
      initialProxyPool={proxyPool}
      initialRequestLogsPage={{
        object: "list",
        data: requestLogsPage.data as RequestLogRow[],
        limit: requestLogsPage.limit,
        page: 1,
        offset: requestLogsPage.offset,
        total: requestLogsPage.total,
        totalPages: Math.max(
          1,
          Math.ceil(requestLogsPage.total / requestLogsPage.limit),
        ),
        summary: {
          errorCount: requestLogsPage.errorCount,
          totalTokens: requestLogsPage.totalTokens,
          cachedTokens: requestLogsPage.cachedTokens,
          cacheHitRate: requestLogsPage.cacheHitRate,
          avgLatencyMs: requestLogsPage.avgLatencyMs,
        },
      }}
      initialOverviewStats={overviewStats}
      initialGlobalSettings={globalSettings}
      initialResourceCounts={{
        apiKeys: apiKeys.length,
        enabledApiKeys: apiKeys.filter((key) => key.enabled).length,
        channels: channels.length,
        enabledChannels: channels.filter((channel) => channel.enabled).length,
        healthyChannels: channels.filter(
          (channel) => channel.status === "healthy",
        ).length,
        credentials: codexCredentials.length,
        proxyPool: proxyPool.length,
        tenants: tenants.length,
      }}
      initialNow={initialNow}
    />
  );
}
