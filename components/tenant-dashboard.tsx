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
  RefreshCwIcon,
  SettingsIcon,
  XCircleIcon,
} from "lucide-react";

import { DashboardChrome, type DashboardNavItem } from "@/components/dashboard-chrome";
import { formatDateTime } from "@/components/dashboard/format";
import { LimitLine } from "@/components/dashboard/limit-line";
import { CreatedApiKeyDialog, TenantApiKeyDialog } from "@/components/tenant/api-key-dialogs";
import { TenantApiKeysSection } from "@/components/tenant/api-keys-section";
import { TenantCodexSetupSection } from "@/components/tenant/codex-setup-section";
import { TenantLogsSection } from "@/components/tenant/logs-section";
import { TenantOverviewSection } from "@/components/tenant/overview-section";
import { TenantResourcesSection } from "@/components/tenant/resources-section";
import { TenantSettingsSection } from "@/components/tenant/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  AdminOverviewStats,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";
import type { RequestLogsPage } from "@/lib/admin-api";
import {
  deleteTenantApiKey,
  getTenantOverview,
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
  | "setup"
  | "apiKeys"
  | "logs"
  | "resources"
  | "settings";

type TenantDashboardProps = {
  initialTenant: PublicTenant;
  initialApiKeys: PublicApiKey[];
  initialResources: TenantResources;
  initialOverviewStats: AdminOverviewStats;
  initialRequestLogsPage: RequestLogsPage;
  initialNow: number;
};

export function TenantDashboard({
  initialTenant,
  initialApiKeys,
  initialResources,
  initialOverviewStats,
  initialRequestLogsPage,
  initialNow,
}: TenantDashboardProps) {
  const [activeSection, setActiveSection] =
    React.useState<TenantSectionId>("overview");
  const [tenant, setTenant] = React.useState(initialTenant);
  const [apiKeys, setApiKeys] = React.useState(initialApiKeys);
  const [resources, setResources] = React.useState(initialResources);
  const [overviewStats, setOverviewStats] =
    React.useState(initialOverviewStats);
  const [requestLogsPage, setRequestLogsPage] = React.useState(
    initialRequestLogsPage,
  );
  const [requestLogsRefreshKey, setRequestLogsRefreshKey] = React.useState(0);
  const [snapshotTime, setSnapshotTime] = React.useState(initialNow);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [createdKey, setCreatedKey] = React.useState<CreatedApiKey | null>(
    null,
  );
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
      getTenantOverview()
        .then((stats) => {
          setOverviewStats(stats);
          setSnapshotTime(Date.now());
        })
        .catch((error) => {
          toast.error(tenantErrorMessage(error));
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function refreshCurrentSection() {
    setRefreshing(true);
    try {
      if (activeSection === "overview") {
        setOverviewStats(await getTenantOverview());
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

  const navigationItems: DashboardNavItem<TenantSectionId>[] = [
    {
      id: "overview",
      label: "总览",
      description: "用量状态",
      icon: GaugeIcon,
    },
    {
      id: "apiKeys",
      label: "密钥",
      description: "租户 Key",
      icon: KeyRoundIcon,
      count: apiKeys.length,
    },
    {
      id: "setup",
      label: "配置",
      description: "Codex 引导",
      icon: BotIcon,
    },
    {
      id: "logs",
      label: "日志",
      description: "请求记录",
      icon: FileTextIcon,
      count: requestLogsPage.total,
    },
    {
      id: "resources",
      label: "资源",
      description: "模型通道",
      icon: NetworkIcon,
      count: resources.channels.length,
    },
    {
      id: "settings",
      label: "设置",
      description: "网络偏好",
      icon: SettingsIcon,
    },
  ];

  return (
    <>
      <DashboardChrome
        activeId={activeSection}
        eyebrow="Tenant Console"
        navItems={navigationItems}
        title={tenant.name}
        description="租户控制台用于管理自己的密钥、请求日志、授权资源和网络偏好。"
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
        snapshot={`数据快照：${formatDateTime(new Date(snapshotTime).toISOString())}`}
        summary={
          <>
            <LimitLine
              label="Key 数"
              value={apiKeys.length}
              limit={tenant.maxApiKeys}
            />
            <LimitLine
              label="今日 token"
              value={tenant.todayTokens}
              limit={tenant.tokenLimitDaily}
            />
            <LimitLine
              label="每分钟请求"
              value={0}
              limit={tenant.rateLimitPerMinute}
              hideValue
            />
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
          <TenantOverviewSection stats={overviewStats} tenant={tenant} />
        )}
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
            tenant={tenant}
            onApiKeyCreated={(created) => {
              setApiKeys((current) => [created, ...current]);
              setCreatedKey(created);
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
      </DashboardChrome>

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
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
          }
        }}
      />
    </>
  );
}
