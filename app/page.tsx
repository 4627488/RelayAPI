import { cookies } from "next/headers";

import { AdminDashboard } from "@/components/admin-dashboard";
import { WebAccessLogin } from "@/components/auth/web-access-login";
import { getAdminOverviewStats } from "@/src/server/repositories/logs";
import { listApiKeyPublicRecords } from "@/src/server/services/apiKeys";
import { listChannelRecords } from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { getPublicGlobalSettings } from "@/src/server/services/settings";
import { listPublicProxyPoolItems } from "@/src/server/services/proxyPool";
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

  // Keep the initial admin payload lean for low-bandwidth deployments. The
  // larger lists are loaded by the client only when their tab is opened.
  const apiKeysForCounts = listApiKeyPublicRecords();
  const channelsForCounts = listChannelRecords();
  const codexCredentialsForCounts = await listPublicCodexCredentials();
  const proxyPoolForCounts = listPublicProxyPoolItems();
  const overviewStats = getAdminOverviewStats() as AdminOverviewStats;
  const globalSettings = getPublicGlobalSettings();
  const initialNow = new Date().getTime();

  return (
    <AdminDashboard
      initialApiKeys={[]}
      initialChannels={[]}
      initialCredentials={[]}
      initialProxyPool={[]}
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
      initialResourceCounts={{
        apiKeys: apiKeysForCounts.length,
        enabledApiKeys: apiKeysForCounts.filter((key) => key.enabled).length,
        channels: channelsForCounts.length,
        enabledChannels: channelsForCounts.filter((channel) => channel.enabled)
          .length,
        healthyChannels: channelsForCounts.filter(
          (channel) => channel.status === "healthy",
        ).length,
        credentials: codexCredentialsForCounts.length,
        proxyPool: proxyPoolForCounts.length,
      }}
      initialNow={initialNow}
    />
  );
}
