"use client";

import * as React from "react";
import { Line, LineChart } from "recharts";
import { toast } from "sonner";
import {
  ActivityIcon,
  AlertTriangleIcon,
  Clock3Icon,
  DatabaseIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  RouteIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  WorkflowIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  DashboardChrome,
  DashboardSummaryLine,
  type DashboardNavItem,
} from "@/components/dashboard-chrome";
import {
  ApiKeysSection,
} from "@/components/admin/api-keys-section";
import { ChannelsSection } from "@/components/admin/channels-section";
import { CredentialsSection } from "@/components/admin/credentials-section";
import { LogsSection } from "@/components/admin/logs-section";
import { ProxyPoolSection } from "@/components/admin/proxy-pool-section";
import {
  adminErrorMessage,
  getGlobalSettings,
  getOverview,
  getRequestLogsPage,
  listApiKeys,
  listChannels,
  listCredentials,
  listProxyPoolItems,
  listTenants,
  logoutWebSession,
  pruneRequestLogs,
  updateGlobalSettings,
  WEB_AUTH_EXPIRED_EVENT,
  type ApiKeyTransferResponse,
  type RequestLogsPage,
} from "@/lib/admin-api";
import { AdminTenantsSection } from "@/components/admin-tenants-section";
import type {
  AdminOverviewStats,
  ChannelRecord,
  CodexCredentialRecord,
  CredentialProxyType,
  CreatedApiKey,
  GlobalSettingsRecord,
  ProxyPoolRecord,
  PublicApiKey,
  PublicTenant,
  TenantUsageStatsRow,
  UsageStatsRow,
} from "@/src/shared/types/entities";

type AdminDashboardProps = {
  initialApiKeys: PublicApiKey[];
  initialTenants: PublicTenant[];
  initialChannels: ChannelRecord[];
  initialCredentials: CodexCredentialRecord[];
  initialProxyPool: ProxyPoolRecord[];
  initialRequestLogsPage: RequestLogsPage;
  initialOverviewStats: AdminOverviewStats;
  initialGlobalSettings: GlobalSettingsRecord;
  initialLoadedData?: Partial<LoadedDataState>;
  initialResourceCounts: AdminResourceCounts;
  initialNow: number;
};

type SectionId =
  | "overview"
  | "tenants"
  | "apiKeys"
  | "credentials"
  | "proxyPool"
  | "channels"
  | "settings"
  | "logs";
type AdminResourceCounts = {
  apiKeys: number;
  enabledApiKeys: number;
  channels: number;
  enabledChannels: number;
  healthyChannels: number;
  credentials: number;
  proxyPool: number;
  tenants: number;
};

type LoadedDataState = Record<
  Exclude<SectionId, "overview">,
  boolean
>;

type TrendDirection = "up" | "down" | "flat";
type TrendTone = "positive" | "negative" | "neutral";

type TrendPoint = {
  date: string;
  value: number;
};

type TrendMetricCardProps = {
  title: string;
  value: string;
  description: string;
  changeLabel: string;
  direction: TrendDirection;
  tone: TrendTone;
  data: TrendPoint[];
  icon: LucideIcon;
};

type CredentialProxyFormState = {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

const WEB_SESSION_EXPIRED_MESSAGE = "管理台会话已过期，请重新登录";
const WEB_SESSION_EXPIRED_REDIRECT_MS = 2200;

export function AdminDashboard({
  initialApiKeys,
  initialTenants,
  initialChannels,
  initialCredentials,
  initialProxyPool,
  initialRequestLogsPage,
  initialOverviewStats,
  initialGlobalSettings,
  initialLoadedData,
  initialResourceCounts,
  initialNow,
}: AdminDashboardProps) {
  const [activeSection, setActiveSection] =
    React.useState<SectionId>("overview");
  const [apiKeys, setApiKeys] = React.useState(initialApiKeys);
  const [tenants, setTenants] = React.useState(initialTenants);
  const [channels, setChannels] = React.useState(initialChannels);
  const [credentials, setCredentials] = React.useState(initialCredentials);
  const [proxyPool, setProxyPool] = React.useState(initialProxyPool);
  const [globalSettings, setGlobalSettings] = React.useState(
    initialGlobalSettings,
  );
  const [requestLogsPage, setRequestLogsPage] = React.useState(
    initialRequestLogsPage,
  );
  const requestLogs = requestLogsPage.data;
  const [loadedData, setLoadedData] = React.useState<LoadedDataState>({
    apiKeys: initialLoadedData?.apiKeys ?? true,
    tenants: initialLoadedData?.tenants ?? true,
    credentials: initialLoadedData?.credentials ?? true,
    proxyPool: initialLoadedData?.proxyPool ?? true,
    channels: initialLoadedData?.channels ?? true,
    settings: initialLoadedData?.settings ?? true,
    logs: initialLoadedData?.logs ?? true,
  });
  const [overviewStats, setOverviewStats] =
    React.useState(initialOverviewStats);
  const [snapshotTime, setSnapshotTime] = React.useState(initialNow);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = React.useState(
    WEB_SESSION_EXPIRED_MESSAGE,
  );
  const sessionRedirectTimerRef = React.useRef<number | null>(null);

  const returnToLogin = React.useCallback(() => {
    window.location.assign("/");
  }, []);

  React.useEffect(() => {
    function handleWebAuthExpired(event: Event) {
      const message =
        event instanceof CustomEvent &&
        typeof event.detail?.message === "string"
          ? event.detail.message
          : WEB_SESSION_EXPIRED_MESSAGE;

      setSessionExpired(true);
      setSessionExpiredMessage(message);

      if (sessionRedirectTimerRef.current === null) {
        sessionRedirectTimerRef.current = window.setTimeout(
          returnToLogin,
          WEB_SESSION_EXPIRED_REDIRECT_MS,
        );
      }
    }

    window.addEventListener(WEB_AUTH_EXPIRED_EVENT, handleWebAuthExpired);
    return () => {
      window.removeEventListener(WEB_AUTH_EXPIRED_EVENT, handleWebAuthExpired);
      if (sessionRedirectTimerRef.current !== null) {
        window.clearTimeout(sessionRedirectTimerRef.current);
        sessionRedirectTimerRef.current = null;
      }
    };
  }, [returnToLogin]);

  const refreshOverviewStats = React.useCallback(async () => {
    const stats = await getOverview();
    setOverviewStats(stats);
    setSnapshotTime(Date.now());
    return stats;
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshOverviewStats().catch((error) => {
        toast.error(adminErrorMessage(error));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshOverviewStats]);

  const loadSectionData = React.useCallback(
    async (section: SectionId, force = false) => {
      if (section !== "overview" && !force && loadedData[section]) {
        return;
      }

      setRefreshing(true);
      try {
        if (section === "overview") {
          await refreshOverviewStats();
        } else if (section === "apiKeys") {
          const [nextApiKeys, nextChannels, nextTenants] = await Promise.all([
            listApiKeys(),
            listChannels(),
            listTenants(),
          ]);
          setApiKeys(nextApiKeys);
          setChannels(nextChannels);
          setTenants(nextTenants);
          setLoadedData((current) => ({
            ...current,
            channels: true,
            tenants: true,
          }));
        } else if (section === "tenants") {
          setTenants(await listTenants());
        } else if (section === "credentials") {
          const [nextCredentials, nextChannels, nextProxyPool] =
            await Promise.all([
              listCredentials(),
              listChannels(),
              listProxyPoolItems(),
            ]);
          setCredentials(nextCredentials);
          setChannels(nextChannels);
          setProxyPool(nextProxyPool);
          setLoadedData((current) => ({
            ...current,
            channels: true,
            proxyPool: true,
          }));
        } else if (section === "proxyPool") {
          setProxyPool(await listProxyPoolItems());
        } else if (section === "channels") {
          const [nextChannels, nextCredentials] = await Promise.all([
            listChannels(),
            listCredentials(),
          ]);
          setChannels(nextChannels);
          setCredentials(nextCredentials);
          setLoadedData((current) => ({ ...current, credentials: true }));
        } else if (section === "settings") {
          setGlobalSettings(await getGlobalSettings());
        } else if (section === "logs") {
          const result = await getRequestLogsPage({
            limit: initialRequestLogsPage.limit,
            page: 1,
          });
          setRequestLogsPage(result);
        }
        setLoadedData((current) => ({ ...current, [section]: true }));
        setSnapshotTime(Date.now());
        return true;
      } catch (error) {
        toast.error(adminErrorMessage(error));
        return false;
      } finally {
        setRefreshing(false);
      }
    },
    [initialRequestLogsPage.limit, loadedData, refreshOverviewStats],
  );

  async function refreshDashboard() {
    if (await loadSectionData(activeSection, true)) {
      toast.success("当前页面数据已刷新");
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await logoutWebSession();
      toast.success("已退出管理台");
      window.location.reload();
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  function handleRequestLogsLoaded(page: RequestLogsPage) {
    setRequestLogsPage(page);
    setLoadedData((current) => ({ ...current, logs: true }));
    setSnapshotTime(Date.now());
  }

  function handleApiKeyCreated(created: CreatedApiKey) {
    setApiKeys((current) => [
      created,
      ...current.filter((apiKey) => apiKey.id !== created.id),
    ]);
  }

  function handleApiKeyUpdated(updated: PublicApiKey) {
    setApiKeys((current) =>
      current.map((apiKey) => (apiKey.id === updated.id ? updated : apiKey)),
    );
  }

  function handleApiKeyDeleted(id: string) {
    setApiKeys((current) => current.filter((apiKey) => apiKey.id !== id));
  }

  function handleApiKeyTransferred(result: ApiKeyTransferResponse) {
    setApiKeys((current) =>
      current.filter((apiKey) => apiKey.id !== result.apiKey.id),
    );
    setTenants((current) =>
      current.map((tenant) =>
        tenant.id === result.tenant.id ? result.tenant : tenant,
      ),
    );
  }

  async function refreshCredentialAndChannelData() {
    const [nextCredentials, nextChannels] = await Promise.all([
      listCredentials(),
      listChannels(),
    ]);
    setCredentials(nextCredentials);
    setChannels(nextChannels);
    setSnapshotTime(Date.now());
    return { credentials: nextCredentials, channels: nextChannels };
  }

  function handleCredentialUpdated(updated: CodexCredentialRecord) {
    setCredentials((current) => [
      updated,
      ...current.filter((credential) => credential.id !== updated.id),
    ]);
  }

  function handleCredentialDeleted(id: string) {
    setCredentials((current) =>
      current.filter((credential) => credential.id !== id),
    );
    setChannels((current) =>
      current
        .map((channel) => {
          const credentialIds = channel.credentialIds.filter(
            (credentialId) => credentialId !== id,
          );
          return {
            ...channel,
            credentialId: credentialIds[0] || channel.credentialId,
            credentialIds,
          };
        })
        .filter((channel) => channel.credentialIds.length > 0),
    );
  }

  function handleChannelCreated(created: ChannelRecord) {
    setChannels((current) => [
      created,
      ...current.filter((channel) => channel.id !== created.id),
    ]);
  }

  function handleChannelUpdated(updated: ChannelRecord) {
    setChannels((current) =>
      current.map((channel) => (channel.id === updated.id ? updated : channel)),
    );
  }

  function handleChannelDeleted(id: string) {
    setChannels((current) => current.filter((channel) => channel.id !== id));
  }

  const totals = overviewStats.totals;
  const apiKeyCount = loadedData.apiKeys
    ? apiKeys.length
    : initialResourceCounts.apiKeys;
  const channelCount = loadedData.channels
    ? channels.length
    : initialResourceCounts.channels;
  const enabledChannelCount = loadedData.channels
    ? channels.filter((channel) => channel.enabled).length
    : initialResourceCounts.enabledChannels;
  const healthyChannelCount = loadedData.channels
    ? channels.filter((channel) => channel.status === "healthy").length
    : initialResourceCounts.healthyChannels;
  const credentialCount = loadedData.credentials
    ? credentials.length
    : initialResourceCounts.credentials;
  const proxyPoolCount = loadedData.proxyPool
    ? proxyPool.length
    : initialResourceCounts.proxyPool;
  const tenantCount = loadedData.tenants
    ? tenants.length
    : initialResourceCounts.tenants;
  const successRate = ratio(totals.successCount, totals.requestCount);
  const hasOperationalData = totals.requestCount > 0;
  const requestLogsRenderKey = `${requestLogsPage.page}:${
    requestLogs[0]?.id ?? "empty"
  }:${requestLogs.length}`;

  const navigationItems: DashboardNavItem<SectionId>[] = [
    {
      id: "overview",
      label: "总览",
      description: "运行概览",
      icon: GaugeIcon,
    },
    {
      id: "credentials",
      label: "凭据",
      description: "Codex 账号",
      icon: UserRoundIcon,
      count: credentialCount,
    },
    {
      id: "proxyPool",
      label: "代理池",
      description: "SOCKS 代理",
      icon: DatabaseIcon,
      count: proxyPoolCount,
    },
    {
      id: "channels",
      label: "通道",
      description: "路由通道",
      icon: RouteIcon,
      count: channelCount,
    },
    {
      id: "tenants",
      label: "租户",
      description: "多租户",
      icon: ShieldCheckIcon,
      count: tenantCount,
    },
    {
      id: "apiKeys",
      label: "密钥",
      description: "API 密钥",
      icon: KeyRoundIcon,
      count: apiKeyCount,
    },
    {
      id: "logs",
      label: "日志",
      description: "最近请求",
      icon: FileTextIcon,
      count: requestLogs.length,
    },
    {
      id: "settings",
      label: "设置",
      description: "全局配置",
      icon: SettingsIcon,
    },
  ];

  return (
    <DashboardChrome
      activeId={activeSection}
      eyebrow="Admin Console"
      navItems={navigationItems}
      width="admin"
      title="RelayAPI Dashboard"
      description="面向转发稳定性的运行控制台：凭据、代理、通道、租户、密钥和请求日志集中管理。"
      status={
        <Badge variant={hasOperationalData ? "secondary" : "outline"}>
          {hasOperationalData ? "运行中" : "等待首个请求"}
        </Badge>
      }
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={sessionExpired || loggingOut}
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
            disabled={sessionExpired || refreshing || loggingOut}
            onClick={refreshDashboard}
          >
            {refreshing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新数据
          </Button>
        </>
      }
      snapshot={
        <>
          数据快照：
          <LocalDateTime value={new Date(snapshotTime).toISOString()} />
        </>
      }
      summary={
        <>
          <DashboardSummaryLine label="租户" value={formatNumber(tenantCount)} />
          <DashboardSummaryLine
            label="通道"
            value={
              <>
                健康 {formatNumber(healthyChannelCount)}/
                {formatNumber(channelCount)}
              </>
            }
          />
          <DashboardSummaryLine
            label="成功率"
            value={formatPercent(successRate)}
          />
        </>
      }
      onNavChange={(section) => {
        setActiveSection(section);
        if (section !== "overview") {
          void loadSectionData(section);
        }
      }}
    >
      {sessionExpired && (
        <Alert variant="destructive" className="mb-4 items-start">
          <AlertTriangleIcon />
          <AlertTitle>管理台会话已过期</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {sessionExpiredMessage}。系统将在{" "}
              {formatDuration(WEB_SESSION_EXPIRED_REDIRECT_MS)} 后返回登录页。
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={returnToLogin}
            >
              立即重新登录
            </Button>
          </AlertDescription>
        </Alert>
      )}
            {activeSection === "overview" && (
              <OverviewSection
                apiKeyCount={apiKeyCount}
                channelCount={channelCount}
                credentialCount={credentialCount}
                enabledChannelCount={enabledChannelCount}
                hasOperationalData={hasOperationalData}
                overviewStats={overviewStats}
                tenantCount={tenantCount}
                onRefresh={refreshOverviewStats}
              />
            )}
            {activeSection === "apiKeys" && (
              <ApiKeysSection
                apiKeys={apiKeys}
                channels={channels}
                onCreated={handleApiKeyCreated}
                onDeleted={handleApiKeyDeleted}
                onTransferred={handleApiKeyTransferred}
                onUpdated={handleApiKeyUpdated}
                tenants={tenants}
              />
            )}
            {activeSection === "tenants" && (
              <AdminTenantsSection tenants={tenants} onChanged={setTenants} />
            )}
            {activeSection === "credentials" && (
              <CredentialsSection
                credentials={credentials}
                globalSettings={globalSettings}
                proxyPool={proxyPool}
                onDeleted={handleCredentialDeleted}
                onRefreshData={refreshCredentialAndChannelData}
                onUpdated={handleCredentialUpdated}
              />
            )}
            {activeSection === "proxyPool" && (
              <ProxyPoolSection
                proxyPool={proxyPool}
                onChanged={setProxyPool}
              />
            )}
            {activeSection === "channels" && (
              <ChannelsSection
                channels={channels}
                credentials={credentials}
                onCreated={handleChannelCreated}
                onDeleted={handleChannelDeleted}
                onUpdated={handleChannelUpdated}
              />
            )}
            {activeSection === "settings" && (
              <SettingsSection
                key={`${globalSettings.proxySource}:${globalSettings.proxy?.enabled}:${globalSettings.proxy?.type}:${globalSettings.proxy?.host}:${globalSettings.proxy?.port}:${globalSettings.proxy?.username}:${globalSettings.proxy?.passwordSet}:${globalSettings.userAgentSource}:${globalSettings.userAgent}:${globalSettings.fullRequestLoggingEnabled}:${globalSettings.codexAutoDisableRefreshExhausted}:${globalSettings.requestLogRetentionDays}:${globalSettings.requestLogDetailRetentionDays}:${globalSettings.updatedAt}`}
                settings={globalSettings}
                onSaved={setGlobalSettings}
              />
            )}
            {activeSection === "logs" && (
              <LogsSection
                key={requestLogsRenderKey}
                initialRequestLogsPage={requestLogsPage}
                onLoaded={handleRequestLogsLoaded}
              />
            )}
    </DashboardChrome>
  );
}

function SettingsSection({
  settings,
  onSaved,
}: {
  settings: GlobalSettingsRecord;
  onSaved: (settings: GlobalSettingsRecord) => void;
}) {
  const [form, setForm] = React.useState(() =>
    globalSettingsProxyForm(settings),
  );
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [userAgent, setUserAgent] = React.useState(settings.userAgent);
  const [userAgentSaving, setUserAgentSaving] = React.useState(false);
  const [loggingSaving, setLoggingSaving] = React.useState(false);
  const [refreshPolicySaving, setRefreshPolicySaving] = React.useState(false);
  const [retentionSaving, setRetentionSaving] = React.useState(false);
  const [pruning, setPruning] = React.useState(false);
  const [retentionForm, setRetentionForm] = React.useState(() => ({
    requestLogRetentionDays: String(settings.requestLogRetentionDays ?? 90),
    requestLogDetailRetentionDays: String(
      settings.requestLogDetailRetentionDays ?? 14,
    ),
    vacuum: false,
  }));
  const proxy = settings.proxy;

  function patchForm(patch: Partial<CredentialProxyFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function saveProxy() {
    const host = form.host.trim();
    const port = integerValue(form.port, 0);
    if (!host) {
      toast.error("请输入全局 SOCKS5 代理主机");
      return;
    }
    if (port < 1 || port > 65535) {
      toast.error("代理端口必须在 1 到 65535 之间");
      return;
    }

    setSaving(true);
    try {
      const payload: {
        enabled: boolean;
        type: CredentialProxyType;
        host: string;
        port: number;
        username: string;
        password?: string;
      } = {
        enabled: form.enabled,
        type: form.type,
        host,
        port,
        username: form.username.trim(),
      };
      if (form.password.trim()) {
        payload.password = form.password;
      }
      const updated = await updateGlobalSettings({ proxy: payload });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("OAuth 登录代理已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearProxy() {
    setClearing(true);
    try {
      const updated = await updateGlobalSettings({ proxy: null });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("OAuth 登录代理已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  async function clearPassword() {
    if (!proxy) {
      return;
    }
    setSaving(true);
    try {
      const updated = await updateGlobalSettings({
        proxy: {
          enabled: proxy.enabled,
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: "",
        },
      });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("全局代理密码已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUserAgent() {
    const value = userAgent.trim();
    setUserAgentSaving(true);
    try {
      const updated = await updateGlobalSettings({ userAgent: value || null });
      onSaved(updated);
      setUserAgent(updated.userAgent);
      toast.success(
        value ? "全局 User-Agent 已保存" : "全局 User-Agent 已清除",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setUserAgentSaving(false);
    }
  }

  async function clearUserAgent() {
    setUserAgentSaving(true);
    try {
      const updated = await updateGlobalSettings({ userAgent: null });
      onSaved(updated);
      setUserAgent(updated.userAgent);
      toast.success("已回退到环境变量或默认 User-Agent");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setUserAgentSaving(false);
    }
  }

  async function updateFullRequestLogging(enabled: boolean) {
    setLoggingSaving(true);
    try {
      const updated = await updateGlobalSettings({
        fullRequestLoggingEnabled: enabled,
      });
      onSaved(updated);
      toast.success(enabled ? "完整转发日志已开启" : "完整转发日志已关闭");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoggingSaving(false);
    }
  }

  async function updateCodexAutoDisableRefreshExhausted(enabled: boolean) {
    setRefreshPolicySaving(true);
    try {
      const updated = await updateGlobalSettings({
        codexAutoDisableRefreshExhausted: enabled,
      });
      onSaved(updated);
      toast.success(
        enabled
          ? "Token 刷新失败自动禁用已开启"
          : "Token 刷新失败自动禁用已关闭",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshPolicySaving(false);
    }
  }

  async function saveRetentionSettings() {
    const requestLogRetentionDays = integerValue(
      retentionForm.requestLogRetentionDays,
      settings.requestLogRetentionDays ?? 90,
    );
    const requestLogDetailRetentionDays = integerValue(
      retentionForm.requestLogDetailRetentionDays,
      settings.requestLogDetailRetentionDays ?? 14,
    );
    if (!isValidRetentionDays(requestLogRetentionDays)) {
      toast.error("概要日志保留天数必须在 1 到 3650 之间");
      return;
    }
    if (!isValidRetentionDays(requestLogDetailRetentionDays)) {
      toast.error("详细日志保留天数必须在 1 到 3650 之间");
      return;
    }

    setRetentionSaving(true);
    try {
      const updated = await updateGlobalSettings({
        requestLogRetentionDays,
        requestLogDetailRetentionDays,
      });
      onSaved(updated);
      setRetentionForm((current) => ({
        ...current,
        requestLogRetentionDays: String(updated.requestLogRetentionDays ?? 90),
        requestLogDetailRetentionDays: String(
          updated.requestLogDetailRetentionDays ?? 14,
        ),
      }));
      toast.success("日志保留策略已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRetentionSaving(false);
    }
  }

  async function pruneLogsNow() {
    const summaryRetentionDays = integerValue(
      retentionForm.requestLogRetentionDays,
      settings.requestLogRetentionDays ?? 90,
    );
    const detailRetentionDays = integerValue(
      retentionForm.requestLogDetailRetentionDays,
      settings.requestLogDetailRetentionDays ?? 14,
    );
    if (!isValidRetentionDays(summaryRetentionDays)) {
      toast.error("概要日志保留天数必须在 1 到 3650 之间");
      return;
    }
    if (!isValidRetentionDays(detailRetentionDays)) {
      toast.error("详细日志保留天数必须在 1 到 3650 之间");
      return;
    }

    setPruning(true);
    try {
      const result = await pruneRequestLogs({
        summaryRetentionDays,
        detailRetentionDays,
        vacuum: retentionForm.vacuum,
      });
      toast.success(
        `日志清理完成：概要 ${formatNumber(result.deletedRequestLogs)} 条，详情 ${formatNumber(result.deletedRequestLogDetails)} 条`,
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPruning(false);
    }
  }

  const pending = saving || clearing;
  const retentionPending = retentionSaving || pruning;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
          <CardDescription>
            配置 Codex 上游 User-Agent、日志策略和 OAuth 登录专用 SOCKS5
            代理。凭据也可以单独覆盖 User-Agent。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          <Alert className="items-start xl:col-span-2">
            <SettingsIcon className="size-4" />
            <AlertTitle>生效范围</AlertTitle>
            <AlertDescription>
              User-Agent 按“凭据覆盖 → 数据库全局设置 →
              环境变量/默认值”生效。全局代理用于 OAuth 登录 callback 换
              token；后续 refresh_token
              和额度查询需在单个凭据中开启全局代理回退。
            </AlertDescription>
          </Alert>

          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm xl:col-span-2">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">Codex User-Agent</div>
                <div className="text-xs text-muted-foreground">
                  当前来源：{userAgentSourceLabel(settings.userAgentSource)}
                  。用于 Codex
                  请求和额度刷新；留空保存会回退到环境变量或默认值。
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    userAgentSaving || settings.userAgentSource !== "database"
                  }
                  onClick={clearUserAgent}
                >
                  {userAgentSaving && <Spinner data-icon="inline-start" />}
                  清除数据库配置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={userAgentSaving}
                  onClick={saveUserAgent}
                >
                  {userAgentSaving && <Spinner data-icon="inline-start" />}
                  保存 User-Agent
                </Button>
              </div>
            </div>
            <Textarea
              className="min-h-20 font-mono text-xs"
              disabled={userAgentSaving}
              value={userAgent}
              placeholder={settings.userAgent}
              onChange={(event) => setUserAgent(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              当前生效：{settings.userAgent || "未配置"}
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">记录完整日志</div>
                <div className="text-xs text-muted-foreground">
                  开启后记录完整请求 body、转发到上游的 payload
                  和上游响应；关闭后只保留概要日志与报错详情。
                </div>
              </div>
              <Switch
                checked={settings.fullRequestLoggingEnabled}
                disabled={loggingSaving}
                size="sm"
                onCheckedChange={(checked) =>
                  void updateFullRequestLogging(Boolean(checked))
                }
              />
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">自动停用错误凭据</div>
                <div className="text-xs text-muted-foreground">
                  Token 定时刷新始终会在凭据过期前 4
                  天尝试执行；失败后每天再试，最多总共尝试 3
                  次。开启此开关后，达到次数上限的错误凭据会自动停用；关闭时仅标记错误，不影响自动刷新。
                </div>
              </div>
              <Switch
                checked={settings.codexAutoDisableRefreshExhausted}
                disabled={refreshPolicySaving}
                size="sm"
                onCheckedChange={(checked) =>
                  void updateCodexAutoDisableRefreshExhausted(Boolean(checked))
                }
              />
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">日志保留与清理</div>
                <div className="text-xs text-muted-foreground">
                  概要日志会影响总览统计；详细日志包含请求/响应体，建议保留更短时间。
                  系统会在请求日志写入时按策略自动清理；“立即清理”只用于马上执行一次。
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={retentionPending}
                  onClick={saveRetentionSettings}
                >
                  {retentionSaving && <Spinner data-icon="inline-start" />}
                  保存策略
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={retentionPending}
                  onClick={pruneLogsNow}
                >
                  {pruning && <Spinner data-icon="inline-start" />}
                  立即清理
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                概要日志保留天数
                <Input
                  disabled={retentionPending}
                  inputMode="numeric"
                  value={retentionForm.requestLogRetentionDays}
                  onChange={(event) =>
                    setRetentionForm((current) => ({
                      ...current,
                      requestLogRetentionDays: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                详细日志保留天数
                <Input
                  disabled={retentionPending}
                  inputMode="numeric"
                  value={retentionForm.requestLogDetailRetentionDays}
                  onChange={(event) =>
                    setRetentionForm((current) => ({
                      ...current,
                      requestLogDetailRetentionDays: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={retentionForm.vacuum}
                disabled={retentionPending}
                onChange={(event) =>
                  setRetentionForm((current) => ({
                    ...current,
                    vacuum: event.target.checked,
                  }))
                }
              />
              <span>
                清理后执行 VACUUM
                释放磁盘空间。大日志库可能耗时较久，期间会阻塞日志库写入。
              </span>
            </label>

            <div className="text-xs text-muted-foreground">
              当前策略：概要{" "}
              {formatNumber(settings.requestLogRetentionDays ?? 90)} 天 · 详细{" "}
              {formatNumber(settings.requestLogDetailRetentionDays ?? 14)} 天
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">OAuth 登录代理</div>
                <div className="text-xs text-muted-foreground">
                  当前来源：{globalProxySourceLabel(settings.proxySource)} ·
                  当前：
                  {globalProxyText(settings)}
                </div>
              </div>
              <Switch
                checked={form.enabled}
                disabled={pending}
                size="sm"
                onCheckedChange={(checked) =>
                  patchForm({ enabled: Boolean(checked) })
                }
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-[0.8fr_1fr_0.7fr]">
              <label className="grid gap-1 text-xs text-muted-foreground">
                协议
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={pending}
                  value={form.type}
                  onChange={(event) =>
                    patchForm({
                      type: event.target.value as CredentialProxyType,
                    })
                  }
                >
                  <option value="socks5h">socks5h</option>
                  <option value="socks5">socks5</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                主机
                <Input
                  disabled={pending}
                  value={form.host}
                  placeholder="127.0.0.1"
                  onChange={(event) => patchForm({ host: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                端口
                <Input
                  disabled={pending}
                  inputMode="numeric"
                  value={form.port}
                  placeholder="1080"
                  onChange={(event) => patchForm({ port: event.target.value })}
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                用户名（可选）
                <Input
                  disabled={pending}
                  value={form.username}
                  placeholder="username"
                  onChange={(event) =>
                    patchForm({ username: event.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                密码（留空则保持原密码）
                <Input
                  disabled={pending}
                  type="password"
                  value={form.password}
                  placeholder={
                    proxy?.passwordSet ? "已设置，留空保持不变" : "password"
                  }
                  onChange={(event) =>
                    patchForm({ password: event.target.value })
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                数据库配置更新时间：{formatNullableDate(settings.updatedAt)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    pending ||
                    settings.proxySource !== "database" ||
                    !proxy?.passwordSet
                  }
                  onClick={clearPassword}
                >
                  {saving && <Spinner data-icon="inline-start" />}
                  清除密码
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || settings.proxySource !== "database"}
                  onClick={clearProxy}
                >
                  {clearing && <Spinner data-icon="inline-start" />}
                  清除数据库代理
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={saveProxy}
                >
                  {saving && <Spinner data-icon="inline-start" />}
                  保存全局代理
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewSection({
  apiKeyCount,
  channelCount,
  credentialCount,
  enabledChannelCount,
  hasOperationalData,
  overviewStats,
  tenantCount,
  onRefresh,
}: {
  apiKeyCount: number;
  channelCount: number;
  credentialCount: number;
  enabledChannelCount: number;
  hasOperationalData: boolean;
  overviewStats: AdminOverviewStats;
  tenantCount: number;
  onRefresh: () => Promise<AdminOverviewStats>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const trendMetrics = buildOverviewTrendMetrics(overviewStats.byDay);
  const topTenants = overviewStats.byTenant.slice(0, 5);
  const topModels = overviewStats.byModel.slice(0, 5);
  const recentDays = overviewStats.byDay.slice(0, 7);

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
      toast.success("总览已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">运行观测</h2>
          <p className="text-sm text-muted-foreground">
            全量请求日志聚合统计；刷新只更新总览聚合数据，不影响配置。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          刷新总览
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {trendMetrics.map((metric) => (
          <TrendMetricCard key={metric.title} {...metric} />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ResourceSummaryCard
          title="租户"
          value={tenantCount}
          description={`${formatNumber(apiKeyCount)} 个 API 密钥归属在租户或全局`}
          icon={ShieldCheckIcon}
        />
        <ResourceSummaryCard
          title="Codex 凭据"
          value={credentialCount}
          description="已授权的 Codex 账号"
          icon={UserRoundIcon}
        />
        <ResourceSummaryCard
          title="通道"
          value={channelCount}
          description={`${formatNumber(enabledChannelCount)} 个通道启用中`}
          icon={RouteIcon}
        />
      </div>

      {!hasOperationalData && (
        <Alert>
          <WorkflowIcon />
          <AlertTitle>还没有请求数据</AlertTitle>
          <AlertDescription>
            创建 Relay API 密钥、配置 Codex 凭据和通道后，调用
            `/v1/models`、`/v1/responses` 或 `/v1/chat/completions`
            即可在这里看到统计和日志。
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <UsageListCard
          title="租户消耗排行"
          description="最近 30 天按 token 消耗排序"
          emptyTitle="暂无租户使用数据"
          rows={topTenants}
        />
        <UsageListCard
          title="模型排行"
          description="最近 30 天按 token 消耗排序"
          emptyTitle="暂无模型使用数据"
          rows={topModels}
        />
        <DailyUsageCard rows={recentDays} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <TenantUsageCard rows={overviewStats.byTenant} />
        <UsageStatsTableCard
          title="通道用量"
          description="按通道聚合的请求、错误和 token 消耗。"
          rows={overviewStats.byChannel}
          emptyTitle="暂无通道使用数据"
        />
        <UsageStatsTableCard
          title="凭据用量"
          description="按 Codex 凭据聚合的公开使用统计。"
          rows={overviewStats.byCredential}
          emptyTitle="暂无凭据使用数据"
        />
        <UsageStatsTableCard
          title="请求类型用量"
          description="按请求类型聚合，辅助区分模型、聊天、响应等入口。"
          rows={overviewStats.byRequestType}
          emptyTitle="暂无请求类型统计"
        />
      </div>
    </div>
  );
}

function TenantUsageCard({ rows }: { rows: TenantUsageStatsRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>租户消耗</CardTitle>
        <CardDescription>
          按租户聚合最近 30 天请求、成功率、token 消耗和今日额度利用率。
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 个租户</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="暂无租户使用统计"
            description="租户调用 Relay API 后，这里会展示其整体消耗。"
            compact
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>租户</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>今日上限</TableHead>
                <TableHead>延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((row, index) => (
                <TableRow key={`${row.key}:${index}`}>
                  <TableCell>
                    <div className="font-medium">{row.tenantName}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.subLabel || row.tenantId || "未归属流量"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <CountCell row={row} />
                  </TableCell>
                  <TableCell>
                    {formatPercent(ratio(row.successCount, row.requestCount))}
                  </TableCell>
                  <TableCell>
                    <TokenCell row={row} />
                  </TableCell>
                  <TableCell>
                    <TenantLimitCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LatencyCell row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function UsageStatsTableCard({
  description,
  emptyTitle,
  rows,
  title,
}: {
  description: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 行</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="产生请求后会自动聚合。"
            compact
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((row, index) => (
                <TableRow key={`${row.key}:${index}`}>
                  <TableCell>
                    <div className="font-medium">{row.label || row.key}</div>
                    {row.subLabel && (
                      <div className="text-xs text-muted-foreground">
                        {row.subLabel}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <CountCell row={row} />
                  </TableCell>
                  <TableCell>
                    {formatPercent(ratio(row.successCount, row.requestCount))}
                  </TableCell>
                  <TableCell>
                    <TokenCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LatencyCell row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CountCell({
  row,
}: {
  row: Pick<UsageStatsRow, "requestCount" | "errorCount" | "streamCount">;
}) {
  return (
    <div>
      <div className="font-medium">{formatNumber(row.requestCount)}</div>
      <div className="text-xs text-muted-foreground">
        {formatNumber(row.errorCount)} 个错误 · {formatNumber(row.streamCount)}{" "}
        个流式
      </div>
    </div>
  );
}

function TokenCell({
  row,
}: {
  row: Pick<
    UsageStatsRow,
    | "promptTokens"
    | "completionTokens"
    | "totalTokens"
    | "cachedTokens"
    | "cacheHitRate"
    | "avgTokensPerRequest"
  >;
}) {
  return (
    <div>
      <div className="font-medium">{formatTokenNumber(row.totalTokens)}</div>
      <div className="text-xs text-muted-foreground">
        P {formatTokenNumber(row.promptTokens)} · C{" "}
        {formatTokenNumber(row.completionTokens)} · 平均{" "}
        {formatTokenNumber(Math.round(row.avgTokensPerRequest))}
      </div>
      <div className="text-xs text-muted-foreground">
        缓存 {formatTokenNumber(row.cachedTokens)} · 命中率{" "}
        {formatPercent(row.cacheHitRate)}
      </div>
    </div>
  );
}

function TenantLimitCell({ row }: { row: TenantUsageStatsRow }) {
  return <DailyLimitCell row={row} />;
}

function DailyLimitCell({
  row,
}: {
  row: Pick<
    TenantUsageStatsRow,
    "tokenLimitDaily" | "todayTokens" | "tokenLimitUtilization"
  >;
}) {
  if (!row.tokenLimitDaily) {
    return <span className="text-muted-foreground">不限制</span>;
  }

  return (
    <div className="grid min-w-32 gap-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{formatTokenNumber(row.todayTokens)}</span>
        <span className="text-muted-foreground">
          每日 {formatTokenNumber(row.tokenLimitDaily)}
        </span>
      </div>
      <Progress value={clamp(row.tokenLimitUtilization || 0, 0, 100)} />
    </div>
  );
}

function LatencyCell({
  row,
}: {
  row: Pick<UsageStatsRow, "avgLatencyMs" | "p95LatencyMs" | "tokensPerSecond">;
}) {
  return (
    <div>
      <div className="font-medium">{formatDuration(row.avgLatencyMs)}</div>
      <div className="text-xs text-muted-foreground">
        p95 {formatDuration(row.p95LatencyMs)} ·{" "}
        {formatTokenNumber(Math.round(row.tokensPerSecond))} token/秒
      </div>
    </div>
  );
}

const OVERVIEW_TREND_DAYS = 7;

type DailyUsageRow = AdminOverviewStats["byDay"][number];

function buildOverviewTrendMetrics(
  rows: AdminOverviewStats["byDay"],
): TrendMetricCardProps[] {
  const days = usageDateWindow(rows, OVERVIEW_TREND_DAYS);
  const today = days[days.length - 1] ?? emptyDailyUsageRow(todayDateKey());
  const yesterday =
    days[days.length - 2] ?? emptyDailyUsageRow(addUtcDays(today.date, -1));
  const requestChange = percentChange(
    today.requestCount,
    yesterday.requestCount,
  );
  const tokenChange = percentChange(today.totalTokens, yesterday.totalTokens);
  const latencyChange = percentChange(today.avgLatencyMs, yesterday.avgLatencyMs);
  const todaySuccessRate = dailySuccessRate(today);
  const yesterdaySuccessRate = dailySuccessRate(yesterday);
  const successPointChange = todaySuccessRate - yesterdaySuccessRate;
  const successDirection = directionFromDelta(successPointChange);

  return [
    {
      title: "今日请求数",
      value: formatCompactNumber(today.requestCount),
      description: `${formatNumber(today.streamCount)} 个流式 · ${formatNumber(today.errorCount)} 个错误`,
      changeLabel: formatChangePercent(requestChange.value),
      direction: requestChange.direction,
      tone: directionTone(requestChange.direction),
      data: days.map((row) => ({ date: row.date, value: row.requestCount })),
      icon: ActivityIcon,
    },
    {
      title: "今日成功率",
      value: formatPercent(todaySuccessRate),
      description: `${formatNumber(today.successCount)} 成功 / ${formatNumber(today.requestCount)} 总计`,
      changeLabel: formatPointChange(successPointChange),
      direction: successDirection,
      tone: directionTone(successDirection),
      data: days.map((row) => ({
        date: row.date,
        value: dailySuccessRate(row),
      })),
      icon: ShieldCheckIcon,
    },
    {
      title: "今日 Token",
      value: formatTokenNumber(today.totalTokens),
      description: `输入 ${formatTokenNumber(today.promptTokens)} · 输出 ${formatTokenNumber(today.completionTokens)} · 缓存 ${formatTokenNumber(today.cachedTokens)} (${formatPercent(today.cacheHitRate)})`,
      changeLabel: formatChangePercent(tokenChange.value),
      direction: tokenChange.direction,
      tone: directionTone(tokenChange.direction),
      data: days.map((row) => ({ date: row.date, value: row.totalTokens })),
      icon: DatabaseIcon,
    },
    {
      title: "今日平均延迟",
      value: formatDuration(today.avgLatencyMs),
      description: `请求平均耗时 · ${formatTokenNumber(Math.round(today.tokensPerSecond))} token/秒`,
      changeLabel: formatChangePercent(latencyChange.value),
      direction: latencyChange.direction,
      tone: directionTone(latencyChange.direction, { lowerIsBetter: true }),
      data: days.map((row) => ({
        date: row.date,
        value: row.avgLatencyMs,
      })),
      icon: Clock3Icon,
    },
  ];
}

function usageDateWindow(rows: AdminOverviewStats["byDay"], days: number) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const today = todayDateKey();
  return Array.from({ length: days }, (_, index) => {
    const date = addUtcDays(today, index - days + 1);
    return byDate.get(date) ?? emptyDailyUsageRow(date);
  });
}

function emptyDailyUsageRow(date: string): DailyUsageRow {
  return {
    date,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    streamCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
    avgTokensPerRequest: 0,
    tokensPerSecond: 0,
  };
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function addUtcDays(dateKey: string, deltaDays: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function dailySuccessRate(row: DailyUsageRow) {
  return ratio(row.successCount, row.requestCount) ?? 0;
}

function percentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { value: 0, direction: "flat" as const };
  }
  if (previous === 0) {
    return {
      value: current > 0 ? 100 : 0,
      direction: current > 0 ? ("up" as const) : ("flat" as const),
    };
  }
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return { value, direction: directionFromDelta(value) };
}

function directionFromDelta(value: number): TrendDirection {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

function directionTone(
  direction: TrendDirection,
  options: { lowerIsBetter?: boolean } = {},
): TrendTone {
  if (direction === "flat") {
    return "neutral";
  }
  if (options.lowerIsBetter) {
    return direction === "down" ? "positive" : "negative";
  }
  return direction === "up" ? "positive" : "negative";
}

function formatChangePercent(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }
  return `${Math.abs(value).toFixed(1)}%`;
}

function formatPointChange(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0pct";
  }
  return `${Math.abs(value).toFixed(1)}pct`;
}

function TrendMetricCard({
  title,
  value,
  description,
  changeLabel,
  direction,
  tone,
  data,
  icon: Icon,
}: TrendMetricCardProps) {
  const directionIcon =
    direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  const toneClasses: Record<TrendTone, string> = {
    positive: "text-emerald-600 dark:text-emerald-400",
    negative: "text-destructive",
    neutral: "text-muted-foreground",
  };

  return (
    <Card className="gap-1 overflow-hidden py-3">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardDescription className="flex items-center gap-1.5 text-sm">
              <Icon className="size-3.5" />
              {title}
            </CardDescription>
            <CardTitle className="text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">
              {value}
            </CardTitle>
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          </div>
          <div
            className={`shrink-0 text-sm font-semibold tabular-nums ${toneClasses[tone]}`}
          >
            {directionIcon} {changeLabel}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`h-10 w-full min-w-0 ${toneClasses[tone]}`}>
          <LineChart
            accessibilityLayer
            width={320}
            height={40}
            data={data}
            margin={{ top: 6, right: 4, bottom: 2, left: 4 }}
            className="h-10 w-full"
          >
            <Line
              type="monotone"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2.2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceSummaryCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardAction>
          <span className="text-lg font-semibold tabular-nums">
            {formatNumber(value)}
          </span>
        </CardAction>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function UsageListCard({
  title,
  description,
  emptyTitle,
  rows,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="产生请求后会自动汇总。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row, index) => (
              <UsageListRow
                key={`${row.key}:${index}`}
                maxTokens={maxTokens}
                row={row}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageListRow({
  maxTokens,
  row,
}: {
  maxTokens: number;
  row: UsageStatsRow;
}) {
  const progressValue = maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;

  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {row.label || row.key || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatNumber(row.requestCount)} 次请求 ·{" "}
            {formatNumber(row.errorCount)} 个错误
          </div>
        </div>
        <div className="text-right text-sm font-medium tabular-nums">
          {formatTokenNumber(row.totalTokens)}
          <div className="text-xs font-normal text-muted-foreground">
            tokens
          </div>
        </div>
      </div>
      <Progress value={clamp(progressValue, 0, 100)} />
    </div>
  );
}

function DailyUsageCard({ rows }: { rows: AdminOverviewStats["byDay"] }) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>每日用量</CardTitle>
        <CardDescription>最近 7 天 token 消耗</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无每日统计"
            description="产生请求后会自动按天聚合。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row) => {
              const progressValue =
                maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;
              return (
                <div key={row.date} className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{row.date}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(row.requestCount)} 次请求 ·{" "}
                        {formatNumber(row.errorCount)} 个错误
                      </div>
                    </div>
                    <div className="text-sm font-medium tabular-nums">
                      {formatTokenNumber(row.totalTokens)}
                    </div>
                  </div>
                  <Progress value={clamp(progressValue, 0, 100)} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({
  compact = false,
  description,
  icon: Icon,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Empty className={compact ? "min-h-36" : "min-h-64"}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function globalSettingsProxyForm(
  settings: GlobalSettingsRecord,
): CredentialProxyFormState {
  const proxy = settings.proxy;
  return {
    enabled: proxy?.enabled ?? true,
    type: proxy?.type ?? "socks5h",
    host: proxy?.host ?? "",
    port: proxy?.port ? String(proxy.port) : "1080",
    username: proxy?.username ?? "",
    password: "",
  };
}

function globalProxyText(settings: GlobalSettingsRecord) {
  const proxy = settings.proxy;
  if (!proxy) {
    return "未配置";
  }
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function globalProxySourceLabel(source: GlobalSettingsRecord["proxySource"]) {
  const labels: Record<GlobalSettingsRecord["proxySource"], string> = {
    database: "数据库",
    environment: "环境变量",
    none: "未配置",
  };
  return labels[source] || source;
}

function userAgentSourceLabel(source: GlobalSettingsRecord["userAgentSource"]) {
  const labels: Record<GlobalSettingsRecord["userAgentSource"], string> = {
    database: "数据库",
    environment: "环境变量",
    default: "默认值",
  };
  return labels[source] || source;
}

function integerValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function isValidRetentionDays(value: number) {
  return Number.isFinite(value) && value >= 1 && value <= 3650;
}

function formatNullableDate(value: string | null) {
  return value ? (
    <LocalDateTime value={value} />
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

function LocalDateTime({ value }: { value: string }) {
  const isClient = React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const date = parseUtcDate(value);
  return (
    <time dateTime={date?.toISOString()} suppressHydrationWarning>
      {isClient ? formatDateTime(value) : "-"}
    </time>
  );
}

function subscribeNoop() {
  return () => undefined;
}

function formatDateTime(value: string) {
  const date = parseUtcDate(value);
  if (!date) {
    return "-";
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function parseUtcDate(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes(" ")
    ? trimmed.replace(" ", "T")
    : trimmed;
  const normalizedWithTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalizedWithTime);
  const timestamp = Date.parse(
    hasTimeZone ? normalizedWithTime : `${normalizedWithTime}Z`,
  );
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 ms";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(value);
}

function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatScaledNumber(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatScaledNumber(value / 1_000_000)}M`;
  }
  if (absValue >= 1_000) {
    return `${formatScaledNumber(value / 1_000)}K`;
  }
  return formatNumber(value);
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

function ratio(numerator: number, denominator: number) {
  if (!denominator) {
    return null;
  }
  return (numerator / denominator) * 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

