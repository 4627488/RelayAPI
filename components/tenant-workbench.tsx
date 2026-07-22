"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  BotIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  NetworkIcon,
  WalletCardsIcon,
  RefreshCwIcon,
  SettingsIcon,
  XCircleIcon,
} from "lucide-react";

import { setDisplayTimeZone } from "@/components/workspace/format";
import { CreatedApiKeyDialog, TenantApiKeyDialog } from "@/components/tenant/api-key-dialogs";
import { TenantApiKeysSection } from "@/components/tenant/api-keys-section";
import { TenantCodexSetupSection } from "@/components/tenant/codex-setup-section";
import { TenantLogsSection } from "@/components/tenant/logs-section";
import { TenantOverviewSection } from "@/components/tenant/overview-section";
import { TenantQuotaSection } from "@/components/tenant/quota-section";
import { TenantResourcesSection } from "@/components/tenant/resources-section";
import { TenantSettingsSection } from "@/components/tenant/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  WorkspaceShell,
  type WorkspaceNavItem,
} from "@/components/workspace/workspace-shell";
import type {
  AdminOverviewStats,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";
import type { RequestLogsPage } from "@/lib/admin-api";
import type { AdminDashboardRequestLogRow } from "@/lib/admin-api";
import { aggregateHourlyTrends } from "@/components/workspace/hourly-trends";
import {
  deleteTenantApiKey,
  getTenantOverview,
  getTenantCostAnalysis,
  getTenantQuota,
  getTenantRequestLogsPage,
  getTenantResources,
  getTenantSettings,
  listTenantApiKeys,
  logoutTenantSession,
  TENANT_AUTH_EXPIRED_EVENT,
  tenantErrorMessage,
} from "@/lib/tenant-api";

type TenantSectionId =
  | "overview"
  | "quota"
  | "setup"
  | "apiKeys"
  | "logs"
  | "resources"
  | "settings";

type TenantWorkbenchProps = {
  initialTenant: PublicTenant;
  initialApiKeys: PublicApiKey[];
  initialResources: TenantResources;
  initialOverviewStats: AdminOverviewStats;
  initialRequestLogsPage: RequestLogsPage;
  initialNow: number;
  initialTimeZone: string;
};

export function TenantWorkbench({
  initialTenant,
  initialApiKeys,
  initialResources,
  initialOverviewStats,
  initialRequestLogsPage,
  initialNow,
  initialTimeZone,
}: TenantWorkbenchProps) {
  setDisplayTimeZone(initialTimeZone);
  const [activeSection, setActiveSection] =
    React.useState<TenantSectionId>("overview");
  const [tenant, setTenant] = React.useState(initialTenant);
  const [apiKeys, setApiKeys] = React.useState(initialApiKeys);
  const [resources, setResources] = React.useState(initialResources);
  const [overviewStats, setOverviewStats] =
    React.useState(initialOverviewStats);
  const [personalCostNanoUsd, setPersonalCostNanoUsd] = React.useState<string | null>(null);
  const [overview24hLogs, setOverview24hLogs] = React.useState<AdminDashboardRequestLogRow[]>([]);
  const [requestLogsPage, setRequestLogsPage] = React.useState(
    initialRequestLogsPage,
  );
  const [requestLogsRefreshKey, setRequestLogsRefreshKey] = React.useState(0);
  const [, setSnapshotTime] = React.useState(initialNow);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [createdKey, setCreatedKey] = React.useState<CreatedApiKey | null>(
    null,
  );
  const [codexSetupSecret, setCodexSetupSecret] = React.useState("");
  const [editingKey, setEditingKey] = React.useState<PublicApiKey | null>(null);
  const [creatingKey, setCreatingKey] = React.useState(false);

  React.useEffect(() => {
    function handleTenantAuthExpired() {
      setSessionExpired(true);
    }
    window.addEventListener(TENANT_AUTH_EXPIRED_EVENT, handleTenantAuthExpired);
    return () =>
      window.removeEventListener(
        TENANT_AUTH_EXPIRED_EVENT,
        handleTenantAuthExpired,
      );
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      loadTenantOverview()
        .then(({ stats, cost, logs }) => {
          setOverviewStats(stats);
          setPersonalCostNanoUsd(cost);
          setOverview24hLogs(logs);
          setSnapshotTime(Date.now());
        })
        .catch((error) => {
          toast.error(tenantErrorMessage(error));
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const refreshTenantOverview = React.useCallback(async (days?: number) => {
    const { stats, cost, logs } = await loadTenantOverview(days);
    setOverviewStats(stats);
    setPersonalCostNanoUsd(cost);
    setOverview24hLogs(logs);
    setSnapshotTime(Date.now());
    return stats;
  }, []);

  async function refreshCurrentSection() {
    setRefreshing(true);
    try {
      if (activeSection === "overview") {
        await refreshTenantOverview();
      } else if (activeSection === "apiKeys") {
        setApiKeys(await listTenantApiKeys());
      } else if (activeSection === "setup") {
        const [nextApiKeys, nextResources] = await Promise.all([
          listTenantApiKeys(),
          getTenantResources(),
        ]);
        setApiKeys(nextApiKeys);
        setResources(nextResources);
      } else if (activeSection === "logs") {
        const page = await getTenantRequestLogsPage({
          limit: requestLogsPage.limit,
          page: requestLogsPage.page,
        });
        setRequestLogsPage(page);
        setRequestLogsRefreshKey((current) => current + 1);
      } else if (activeSection === "resources") {
        setResources(await getTenantResources());
      } else if (activeSection === "settings") {
        setTenant(await getTenantSettings());
      }
      setSnapshotTime(Date.now());
      toast.success("当前页面数据已刷新");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await logoutTenantSession();
      window.location.reload();
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  async function removeKey(id: string) {
    try {
      await deleteTenantApiKey(id);
      setApiKeys((current) => current.filter((key) => key.id !== id));
      toast.success("API 密钥已删除");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    }
  }

  const navigationItems: WorkspaceNavItem<TenantSectionId>[] = [
    {
      id: "overview",
      label: "用量总览",
      icon: GaugeIcon,
      group: "用量",
    },
    {
      id: "quota",
      label: "份额额度",
      icon: WalletCardsIcon,
      group: "用量",
    },
    {
      id: "apiKeys",
      label: "API 密钥",
      icon: KeyRoundIcon,
      count: apiKeys.length,
      group: "访问",
    },
    {
      id: "setup",
      label: "客户端接入",
      icon: BotIcon,
      group: "连接",
    },
    {
      id: "logs",
      label: "请求日志",
      icon: FileTextIcon,
      count: requestLogsPage.total,
      group: "诊断",
    },
    {
      id: "resources",
      label: "资源",
      icon: NetworkIcon,
      count: resources.channels.length,
      group: "配置",
    },
    {
      id: "settings",
      label: "设置",
      icon: SettingsIcon,
      group: "配置",
    },
  ];

  return (
    <>
      <WorkspaceShell
        activeId={activeSection}
        navItems={navigationItems}
        title={navigationItems.find((item) => item.id === activeSection)?.label ?? tenant.name}
        status={
          <Badge variant={tenant.enabled ? "secondary" : "destructive"}>
            {tenant.enabled ? "启用" : "停用"}
          </Badge>
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={loggingOut}
              onClick={logout}
            >
              {loggingOut ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <XCircleIcon data-icon="inline-start" />
              )}
              登出
            </Button>
            <Button
              type="button"
              disabled={refreshing || loggingOut}
              onClick={refreshCurrentSection}
            >
              {refreshing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新
            </Button>
          </>
        }
        onNavChange={setActiveSection}
      >
        {sessionExpired && (
          <Alert variant="destructive" className="mb-4">
            <AlertTriangleIcon />
            <AlertTitle>租户会话已过期</AlertTitle>
            <AlertDescription>请刷新页面后重新登录。</AlertDescription>
          </Alert>
        )}
        {activeSection === "overview" && (
          <TenantOverviewSection
            hourlyTrends={aggregateHourlyTrends(overview24hLogs)}
            onRangeChange={refreshTenantOverview}
            personalCostNanoUsd={personalCostNanoUsd}
            stats={overviewStats}
            tenant={tenant}
          />
        )}
        {activeSection === "quota" && <TenantQuotaSection />}
        {activeSection === "apiKeys" && (
          <TenantApiKeysSection
            apiKeys={apiKeys}
            resources={resources}
            onCreate={() => setCreatingKey(true)}
            onDelete={removeKey}
            onEdit={setEditingKey}
          />
        )}
        {activeSection === "setup" && (
          <TenantCodexSetupSection
            apiKeys={apiKeys}
            initialSecret={codexSetupSecret}
            resources={resources}
            tenant={tenant}
            onApiKeyCreated={(created) => {
              setApiKeys((current) => [created, ...current]);
            }}
          />
        )}
        {activeSection === "logs" && (
          <TenantLogsSection
            key={requestLogsRefreshKey}
            initialPage={requestLogsPage}
            onLoaded={setRequestLogsPage}
          />
        )}
        {activeSection === "resources" && (
          <TenantResourcesSection resources={resources} tenant={tenant} />
        )}
        {activeSection === "settings" && (
          <TenantSettingsSection tenant={tenant} onSaved={setTenant} />
        )}
      </WorkspaceShell>

      <TenantApiKeyDialog
        key={`create:${creatingKey ? "open" : "closed"}`}
        mode="create"
        open={creatingKey}
        resources={resources}
        onOpenChange={setCreatingKey}
        onSaved={(created) => {
          setApiKeys((current) => [created, ...current]);
          if ("key" in created) {
            setCreatedKey(created);
          }
        }}
      />
      <TenantApiKeyDialog
        key={`edit:${editingKey?.id || "none"}`}
        apiKey={editingKey}
        mode="edit"
        open={Boolean(editingKey)}
        resources={resources}
        onOpenChange={(open) => {
          if (!open) {
            setEditingKey(null);
          }
        }}
        onSaved={(updated) => {
          setApiKeys((current) =>
            current.map((key) => (key.id === updated.id ? updated : key)),
          );
          setEditingKey(null);
        }}
      />
      <CreatedApiKeyDialog
        apiKey={createdKey}
        onContinue={(apiKey) => {
          setCodexSetupSecret(apiKey.key);
          setCreatedKey(null);
          setActiveSection("setup");
        }}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
          }
        }}
      />
    </>
  );
}

async function loadTenantOverview(days?: number) {
  const [stats, cost, logsPage] = await Promise.all([
    getTenantOverview({ days }),
    loadPersonalCost(),
    getTenantRequestLogsPage({
      limit: 500,
      page: 1,
      from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    }),
  ]);
  return { stats, cost, logs: logsPage.data };
}

async function loadPersonalCost() {
  const quota = await getTenantQuota();
  const costs = await Promise.all(
    quota.subscriptions.map((subscription) =>
      getTenantCostAnalysis(subscription.id),
    ),
  );
  return costs
    .reduce(
      (total, item) => total + BigInt(item.totalCostNanoUsd || "0"),
      0n,
    )
    .toString();
}
