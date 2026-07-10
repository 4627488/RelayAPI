"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import {
  ActivityIcon,
  AlertTriangleIcon,
  Clock3Icon,
  DatabaseIcon,
  FileTextIcon,
  GaugeIcon,
  RefreshCwIcon,
  RouteIcon,
  SettingsIcon,
  ShieldCheckIcon,
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { DataPanel } from "@/components/workspace/data-panel";
import {
  formatDateTime,
  getDisplayTimeZone,
  setDisplayTimeZone,
} from "@/components/workspace/format";
import { MetricStrip, MetricStripItem } from "@/components/workspace/metric-strip";
import {
  WorkspaceShell,
  type WorkspaceNavItem,
} from "@/components/workspace/workspace-shell";
import {
  ApiKeysSection,
} from "@/components/admin/api-keys-section";
import { ChannelsSection } from "@/components/admin/channels-section";
import { CredentialsSection } from "@/components/admin/credentials-section";
import { LogsSection } from "@/components/admin/logs-section";
import { ProxyPoolSection } from "@/components/admin/proxy-pool-section";
import {
  adminErrorMessage,
  changeAdminPassword,
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
  DailyDimensionUsageStatsRow,
  DailyUsageStatsRow,
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
import {
  addDateKeyDays,
  instantToDateKey,
  parseInstant,
} from "@/src/shared/time";

type AdminWorkbenchProps = {
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
  | "traffic"
  | "routing"
  | "access"
  | "settings";
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

type LoadedDataState = {
  apiKeys: boolean;
  tenants: boolean;
  credentials: boolean;
  proxyPool: boolean;
  channels: boolean;
  settings: boolean;
  logs: boolean;
};

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

export function AdminWorkbench({
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
}: AdminWorkbenchProps) {
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
  setDisplayTimeZone(globalSettings.timeZone);
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
  const [, setSnapshotTime] = React.useState(initialNow);
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

  const refreshOverviewStats = React.useCallback(async (days?: number) => {
    const stats = await getOverview({ days });
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
      const alreadyLoaded =
        section === "overview" ||
        (section === "traffic" && loadedData.logs) ||
        (section === "routing" &&
          loadedData.credentials &&
          loadedData.channels &&
          loadedData.proxyPool) ||
        (section === "access" &&
          loadedData.apiKeys &&
          loadedData.tenants &&
          loadedData.channels) ||
        (section === "settings" && loadedData.settings);

      if (!force && alreadyLoaded) {
        return;
      }

      setRefreshing(true);
      try {
        if (section === "overview") {
          await refreshOverviewStats();
        } else if (section === "access") {
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
            apiKeys: true,
            channels: true,
            tenants: true,
          }));
        } else if (section === "routing") {
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
            credentials: true,
            channels: true,
            proxyPool: true,
          }));
        } else if (section === "settings") {
          setGlobalSettings(await getGlobalSettings());
          setLoadedData((current) => ({ ...current, settings: true }));
        } else if (section === "traffic") {
          const result = await getRequestLogsPage({
            limit: initialRequestLogsPage.limit,
            page: 1,
          });
          setRequestLogsPage(result);
          setLoadedData((current) => ({ ...current, logs: true }));
        }
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

  async function refreshWorkbench() {
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
  const credentialCount = loadedData.credentials
    ? credentials.length
    : initialResourceCounts.credentials;
  const tenantCount = loadedData.tenants
    ? tenants.length
    : initialResourceCounts.tenants;
  const hasOperationalData = totals.requestCount > 0;
  const requestLogsRenderKey = `${requestLogsPage.page}:${
    requestLogs[0]?.id ?? "empty"
  }:${requestLogs.length}:${requestLogsPage.total}`;

  const navigationItems: WorkspaceNavItem<SectionId>[] = [
    {
      id: "overview",
      label: "运行总览",
      icon: GaugeIcon,
      group: "监控",
    },
    {
      id: "traffic",
      label: "请求日志",
      icon: FileTextIcon,
      count: requestLogsPage.total,
      group: "监控",
    },
    {
      id: "routing",
      label: "路由资源",
      icon: RouteIcon,
      count: channelCount,
      group: "调度",
    },
    {
      id: "access",
      label: "租户与密钥",
      icon: ShieldCheckIcon,
      count: apiKeyCount + tenantCount,
      group: "权限",
    },
    {
      id: "settings",
      label: "全局设置",
      icon: SettingsIcon,
      group: "系统",
    },
  ];

  return (
    <WorkspaceShell
      activeId={activeSection}
      navItems={navigationItems}
      width="admin"
      title={navigationItems.find((item) => item.id === activeSection)?.label ?? "运行总览"}
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
            onClick={refreshWorkbench}
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
            {activeSection === "traffic" && (
              <LogsSection
                key={requestLogsRenderKey}
                initialRequestLogsPage={requestLogsPage}
                onLoaded={handleRequestLogsLoaded}
              />
            )}
            {activeSection === "routing" && (
              <div className="grid gap-3">
                <CredentialsSection
                  credentials={credentials}
                  globalSettings={globalSettings}
                  proxyPool={proxyPool}
                  onDeleted={handleCredentialDeleted}
                  onRefreshData={refreshCredentialAndChannelData}
                  onUpdated={handleCredentialUpdated}
                />
                <div className="grid gap-3 xl:grid-cols-2">
                  <ChannelsSection
                    channels={channels}
                    credentials={credentials}
                    onCreated={handleChannelCreated}
                    onDeleted={handleChannelDeleted}
                    onUpdated={handleChannelUpdated}
                  />
                  <ProxyPoolSection
                    proxyPool={proxyPool}
                    onChanged={setProxyPool}
                  />
                </div>
              </div>
            )}
            {activeSection === "access" && (
              <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <AdminTenantsSection tenants={tenants} onChanged={setTenants} publicBaseUrl={globalSettings.publicBaseUrl} />
                <ApiKeysSection
                  apiKeys={apiKeys}
                  channels={channels}
                  onCreated={handleApiKeyCreated}
                  onDeleted={handleApiKeyDeleted}
                  onTransferred={handleApiKeyTransferred}
                  onUpdated={handleApiKeyUpdated}
                  tenants={tenants}
                />
              </div>
            )}
            {activeSection === "settings" && (
              <SettingsSection
                key={`${globalSettings.proxySource}:${globalSettings.proxy?.enabled}:${globalSettings.proxy?.type}:${globalSettings.proxy?.host}:${globalSettings.proxy?.port}:${globalSettings.proxy?.username}:${globalSettings.proxy?.passwordSet}:${globalSettings.userAgentSource}:${globalSettings.userAgent}:${globalSettings.fullRequestLoggingEnabled}:${globalSettings.codexAutoDisableRefreshExhausted}:${globalSettings.requestLogRetentionDays}:${globalSettings.requestLogDetailRetentionDays}:${globalSettings.updatedAt}`}
                settings={globalSettings}
                onSaved={setGlobalSettings}
              />
            )}
    </WorkspaceShell>
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
  const [timeZone, setTimeZone] = React.useState(
    settings.timeZonePending || settings.timeZone,
  );
  const [timeZoneSaving, setTimeZoneSaving] = React.useState(false);
  const [pruning, setPruning] = React.useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = React.useState(settings.publicBaseUrl);
  const [publicBaseUrlSaving, setPublicBaseUrlSaving] = React.useState(false);
  const [adminPasswords, setAdminPasswords] = React.useState({ current: "", next: "", confirm: "" });
  const [adminPasswordSaving, setAdminPasswordSaving] = React.useState(false);
  const [retentionForm, setRetentionForm] = React.useState(() => ({
    requestLogRetentionDays: String(settings.requestLogRetentionDays ?? 90),
    requestLogDetailRetentionDays: String(
      settings.requestLogDetailRetentionDays ?? 14,
    ),
    vacuum: false,
  }));
  const proxy = settings.proxy;
  const timeZones = React.useMemo(() => supportedTimeZones(), []);

  React.useEffect(() => {
    if (
      settings.timeZoneRebuildStatus !== "pending" &&
      settings.timeZoneRebuildStatus !== "running"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void getGlobalSettings()
        .then(onSaved)
        .catch((error) => toast.error(adminErrorMessage(error)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onSaved, settings.timeZoneRebuildStatus]);

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

  async function savePublicBaseUrl() {
    setPublicBaseUrlSaving(true);
    try {
      const updated = await updateGlobalSettings({ publicBaseUrl: publicBaseUrl.trim() });
      onSaved(updated); setPublicBaseUrl(updated.publicBaseUrl);
      toast.success("公开网站地址已保存");
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setPublicBaseUrlSaving(false); }
  }

  async function saveAdminPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adminPasswords.next.length < 10) return toast.error("新密码至少需要 10 位");
    if (adminPasswords.next !== adminPasswords.confirm) return toast.error("两次输入的新密码不一致");
    setAdminPasswordSaving(true);
    try {
      await changeAdminPassword({ currentPassword: adminPasswords.current, newPassword: adminPasswords.next });
      setAdminPasswords({ current: "", next: "", confirm: "" });
      toast.success("管理员密码已修改，其他会话已失效");
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setAdminPasswordSaving(false); }
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

  async function saveTimeZone() {
    const value = timeZone.trim();
    if (!value) {
      toast.error("请选择有效的 IANA 时区");
      return;
    }
    setTimeZoneSaving(true);
    try {
      const updated = await updateGlobalSettings({ timeZone: value });
      onSaved(updated);
      toast.success(
        updated.timeZoneRebuildStatus === "idle"
          ? "全局时区未发生变化"
          : "已开始在后台重建每日统计",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setTimeZoneSaving(false);
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
    <div className="grid gap-3">
      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          <div className="grid gap-3 rounded-md border bg-muted/25 p-3 text-sm">
            <div className="font-medium">公开网站地址</div>
            <Field><FieldLabel htmlFor="public-base-url">外部访问 URL</FieldLabel><Input id="public-base-url" type="url" value={publicBaseUrl} placeholder="https://relay.example.com" onChange={(event) => setPublicBaseUrl(event.target.value)} /><FieldDescription>用于生成邀请和密码重置链接；留空时使用当前浏览器域名。</FieldDescription></Field>
            <div><Button type="button" size="sm" disabled={publicBaseUrlSaving} onClick={savePublicBaseUrl}>{publicBaseUrlSaving && <Spinner data-icon="inline-start" />}保存网站地址</Button></div>
          </div>
          <div className="grid gap-3 rounded-md border bg-muted/25 p-3 text-sm">
            <div className="font-medium">管理员密码</div>
            <form className="grid gap-3" onSubmit={saveAdminPassword}>
              <FieldGroup><Field><FieldLabel htmlFor="admin-current-password">当前密码</FieldLabel><Input id="admin-current-password" type="password" autoComplete="current-password" value={adminPasswords.current} onChange={(event) => setAdminPasswords((value) => ({ ...value, current: event.target.value }))} /></Field><Field><FieldLabel htmlFor="admin-next-password">新密码</FieldLabel><Input id="admin-next-password" type="password" autoComplete="new-password" value={adminPasswords.next} onChange={(event) => setAdminPasswords((value) => ({ ...value, next: event.target.value }))} /></Field><Field><FieldLabel htmlFor="admin-confirm-password">确认新密码</FieldLabel><Input id="admin-confirm-password" type="password" autoComplete="new-password" value={adminPasswords.confirm} onChange={(event) => setAdminPasswords((value) => ({ ...value, confirm: event.target.value }))} /></Field></FieldGroup>
              <div><Button type="submit" size="sm" disabled={adminPasswordSaving}>{adminPasswordSaving && <Spinner data-icon="inline-start" />}修改管理员密码</Button></div>
            </form>
          </div>
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm xl:col-span-2">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">Codex User-Agent</div>
                <div className="font-mono text-xs text-muted-foreground">
                  source={userAgentSourceLabel(settings.userAgentSource)}
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
                  清除
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={userAgentSaving}
                  onClick={saveUserAgent}
                >
                  {userAgentSaving && <Spinner data-icon="inline-start" />}
                  保存
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
              active: {settings.userAgent || "-"}
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">全局时区</div>
                <div className="font-mono text-xs text-muted-foreground">
                  active={settings.timeZone}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={
                  timeZoneSaving ||
                  settings.timeZoneRebuildStatus === "pending" ||
                  settings.timeZoneRebuildStatus === "running"
                }
                onClick={saveTimeZone}
              >
                {(timeZoneSaving ||
                  settings.timeZoneRebuildStatus === "pending" ||
                  settings.timeZoneRebuildStatus === "running") && (
                  <Spinner data-icon="inline-start" />
                )}
                保存并重建
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor="global-time-zone">IANA 时区</FieldLabel>
              <Input
                id="global-time-zone"
                list="global-time-zone-options"
                autoComplete="off"
                disabled={
                  timeZoneSaving ||
                  settings.timeZoneRebuildStatus === "pending" ||
                  settings.timeZoneRebuildStatus === "running"
                }
                value={timeZone}
                placeholder="Asia/Shanghai"
                onChange={(event) => setTimeZone(event.target.value)}
              />
              <datalist id="global-time-zone-options">
                {timeZones.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
              <FieldDescription>
                时间展示、今日额度、趋势图和热力图使用此时区。切换完成前继续使用旧时区。
              </FieldDescription>
            </Field>
            {(settings.timeZoneRebuildStatus === "pending" ||
              settings.timeZoneRebuildStatus === "running") && (
              <Alert>
                <Spinner />
                <AlertTitle>正在重建每日统计</AlertTitle>
                <AlertDescription>
                  正在从 {settings.timeZone} 切换到 {settings.timeZonePending}。
                </AlertDescription>
              </Alert>
            )}
            {settings.timeZoneRebuildStatus === "failed" && (
              <Alert variant="destructive">
                <AlertTriangleIcon />
                <AlertTitle>时区切换失败</AlertTitle>
                <AlertDescription>
                  {settings.timeZoneRebuildError || "后台重建失败，请重新保存后重试。"}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">记录完整日志</div>
                <div className="font-mono text-xs text-muted-foreground">
                  body / upstream payload
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
                <div className="font-mono text-xs text-muted-foreground">
                  refresh exhausted
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
                <div className="font-mono text-xs text-muted-foreground">
                  summary / detail retention
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
  onRefresh: (days?: number) => Promise<AdminOverviewStats>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [overviewDays, setOverviewDays] = React.useState(
    String(overviewStats.range?.days || 30),
  );
  const [selectedDate, setSelectedDate] = React.useState(
    overviewStats.byDay[0]?.date || todayDateKey(),
  );
  const trendMetrics = buildOverviewTrendMetrics(overviewStats.byDay);
  const topTenants = overviewStats.byTenant.slice(0, 5);
  const topModels = overviewStats.byModel.slice(0, 5);
  const recentDays = usageDateWindow(overviewStats.byDay, Number(overviewDays));
  const effectiveSelectedDate = overviewStats.byDay.some(
    (row) => row.date === selectedDate,
  )
    ? selectedDate
    : overviewStats.byDay[0]?.date || todayDateKey();

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh(Number(overviewDays));
      toast.success("总览已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function changeOverviewDays(value: string) {
    if (!value || value === overviewDays) {
      return;
    }
    setOverviewDays(value);
    setRefreshing(true);
    try {
      const stats = await onRefresh(Number(value));
      setSelectedDate(stats.byDay[0]?.date || todayDateKey());
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-6">
      <DataPanel
        title="运行观测"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={refresh}
          >
            {refreshing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新
          </Button>
        }
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid gap-1">
            <div className="text-xs text-muted-foreground">观察窗口</div>
            <div className="font-mono text-sm tabular-nums">
              {overviewStats.range.from} / {overviewStats.range.to} /{" "}
              {formatNumber(overviewStats.range.days)}d
            </div>
          </div>
          <ToggleGroup
            value={[overviewDays]}
            variant="outline"
            size="sm"
            onValueChange={(value) => void changeOverviewDays(String(value[0] || ""))}
          >
            {["7", "14", "30", "90"].map((days) => (
              <ToggleGroupItem key={days} value={days}>
                {days} 天
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </DataPanel>

      {!hasOperationalData && (
        <Alert>
          <WorkflowIcon />
          <AlertTitle>暂无请求数据</AlertTitle>
          <AlertDescription>等待配置和请求。</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {trendMetrics.map((metric) => (
          <TrendMetricCard key={metric.title} {...metric} />
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(20rem,0.7fr)]">
        <DailyOperationsCard rows={recentDays} />
        <AnomalyRadarCard anomalies={overviewStats.anomalies} />
      </div>

      <OperationsStatusStrip stats={overviewStats} />

      <details className="group rounded-md border bg-card">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium marker:hidden">
          深度分析
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            排行、每日矩阵与维度钻取
          </span>
        </summary>
        <div className="grid gap-4 border-t p-3">
          <MetricStrip className="md:grid-cols-3 xl:grid-cols-3">
            <MetricStripItem label="租户" value={formatNumber(tenantCount)} detail={`${formatNumber(apiKeyCount)} Key`} />
            <MetricStripItem label="Codex 凭据" value={formatNumber(credentialCount)} detail="已授权" />
            <MetricStripItem label="通道" value={formatNumber(channelCount)} detail={`${formatNumber(enabledChannelCount)} 启用`} />
          </MetricStrip>
          <DailyBreakdownCard rows={recentDays} selectedDate={effectiveSelectedDate} tenantRows={overviewStats.byTenantDay} modelRows={overviewStats.byModelDay} onSelectDate={setSelectedDate} />
          <DailyDimensionTabs selectedDate={effectiveSelectedDate} tenantRows={overviewStats.byTenantDay} modelRows={overviewStats.byModelDay} channelRows={overviewStats.byChannelDay} credentialRows={overviewStats.byCredentialDay} requestTypeRows={overviewStats.byRequestTypeDay} errorRows={overviewStats.byErrorCodeDay} />
          <div className="grid gap-4 xl:grid-cols-3">
            <UsageListCard title="租户消耗排行" emptyTitle="暂无租户使用数据" rows={topTenants} />
            <UsageListCard title="模型排行" emptyTitle="暂无模型使用数据" rows={topModels} />
            <DailyUsageCard rows={recentDays} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <TenantUsageCard rows={overviewStats.byTenant} />
            <UsageStatsTableCard title="通道用量" rows={overviewStats.byChannel} emptyTitle="暂无通道使用数据" />
            <UsageStatsTableCard title="凭据用量" rows={overviewStats.byCredential} emptyTitle="暂无凭据使用数据" />
            <UsageStatsTableCard title="请求类型用量" rows={overviewStats.byRequestType} emptyTitle="暂无请求类型统计" />
          </div>
        </div>
      </details>
    </div>
  );
}

type DailyTrendMetric =
  | "requests"
  | "tokens"
  | "errorRate"
  | "latency"
  | "cache"
  | "stream";

const DAILY_TREND_METRICS: Array<{ id: DailyTrendMetric; label: string }> = [
  { id: "requests", label: "请求" },
  { id: "tokens", label: "Token" },
  { id: "errorRate", label: "错误率" },
  { id: "latency", label: "延迟" },
  { id: "cache", label: "缓存" },
  { id: "stream", label: "流式" },
];

const dailyChartConfig = {
  requestCount: { label: "请求数", color: "var(--chart-1)" },
  errorCount: { label: "错误数", color: "var(--chart-5)" },
  totalTokens: { label: "Token", color: "var(--chart-2)" },
  errorRate: { label: "错误率", color: "var(--chart-5)" },
  avgLatencyMs: { label: "平均延迟", color: "var(--chart-3)" },
  cacheHitRate: { label: "缓存命中", color: "var(--chart-4)" },
  streamRate: { label: "流式占比", color: "var(--chart-1)" },
} satisfies ChartConfig;

function OperationsStatusStrip({ stats }: { stats: AdminOverviewStats }) {
  const latest = usageDateWindow(stats.byDay, 2).at(-1);
  const errorRate = latest ? ratio(latest.errorCount, latest.requestCount) : null;
  const streamRate = latest ? ratio(latest.streamCount, latest.requestCount) : null;
  const status =
    !latest || latest.requestCount === 0
      ? "等待流量"
      : (errorRate || 0) >= 15
        ? "错误严重"
        : latest.avgLatencyMs >= 10_000
          ? "延迟偏高"
          : (errorRate || 0) >= 5
            ? "错误偏高"
            : "运行稳定";
  const statusVariant =
    status === "运行稳定"
      ? "secondary"
      : status === "等待流量"
        ? "outline"
        : "destructive";

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <SignalCard
        label="运行状态"
        value={status}
        detail={`最近请求 ${stats.totals.lastRequestAt ? formatDateTime(stats.totals.lastRequestAt) : "-"}`}
        badge={<Badge variant={statusVariant}>{status}</Badge>}
      />
      <SignalCard
        label="今日错误率"
        value={formatPercent(errorRate)}
        detail={`${formatNumber(latest?.errorCount || 0)} 个错误 / ${formatNumber(latest?.requestCount || 0)} 次请求`}
      />
      <SignalCard
        label="今日流式占比"
        value={formatPercent(streamRate)}
        detail={`${formatNumber(latest?.streamCount || 0)} 个流式请求`}
      />
      <SignalCard
        label="缓存命中"
        value={formatPercent(latest?.cacheHitRate ?? null)}
        detail={`缓存 ${formatTokenNumber(latest?.cachedTokens || 0)} token`}
      />
    </div>
  );
}

function SignalCard({
  badge,
  detail,
  label,
  value,
}: {
  badge?: React.ReactNode;
  detail: string;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="text-xs text-muted-foreground">{label}</div>
        {badge && <CardAction>{badge}</CardAction>}
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </CardHeader>
    </Card>
  );
}

function DailyOperationsCard({ rows }: { rows: DailyUsageStatsRow[] }) {
  const [metric, setMetric] = React.useState<DailyTrendMetric>("requests");
  const data = rows.map((row) => ({
    ...row,
    errorRate: ratio(row.errorCount, row.requestCount) || 0,
    streamRate: ratio(row.streamCount, row.requestCount) || 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>每日运行趋势</CardTitle>
        <CardAction>
          <ToggleGroup
            value={[metric]}
            variant="outline"
            size="sm"
            onValueChange={(value) =>
              value[0] && setMetric(value[0] as DailyTrendMetric)
            }
          >
            {DAILY_TREND_METRICS.map((item) => (
              <ToggleGroupItem key={item.id} value={item.id}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无趋势数据"
            description="等待请求。"
            compact
          />
        ) : (
          <ChartContainer
            config={dailyChartConfig}
            className="h-72 w-full aspect-auto"
            initialDimension={{ width: 900, height: 288 }}
          >
            {renderDailyTrendChart(metric, data)}
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function renderDailyTrendChart(
  metric: DailyTrendMetric,
  data: Array<DailyUsageStatsRow & { errorRate: number; streamRate: number }>,
) {
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
      <YAxis tickLine={false} axisLine={false} width={48} />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );
  if (metric === "requests") {
    return (
      <BarChart data={data}>
        {common}
        <Bar dataKey="requestCount" fill="var(--color-requestCount)" radius={4} />
        <Bar dataKey="errorCount" fill="var(--color-errorCount)" radius={4} />
      </BarChart>
    );
  }
  if (metric === "tokens") {
    return (
      <AreaChart data={data}>
        {common}
        <Area
          dataKey="totalTokens"
          fill="var(--color-totalTokens)"
          fillOpacity={0.22}
          stroke="var(--color-totalTokens)"
          strokeWidth={2}
          type="monotone"
        />
      </AreaChart>
    );
  }
  const dataKey =
    metric === "errorRate"
      ? "errorRate"
      : metric === "latency"
        ? "avgLatencyMs"
        : metric === "cache"
          ? "cacheHitRate"
          : "streamRate";
  return (
    <LineChart data={data}>
      {common}
      <Line
        dataKey={dataKey}
        dot={false}
        stroke={`var(--color-${dataKey})`}
        strokeWidth={2.2}
        type="monotone"
      />
    </LineChart>
  );
}

function AnomalyRadarCard({
  anomalies,
}: {
  anomalies: AdminOverviewStats["anomalies"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>异常雷达</CardTitle>
        <CardAction>
          <Badge variant={anomalies.length > 0 ? "destructive" : "secondary"}>
            {formatNumber(anomalies.length)} 项
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {anomalies.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="暂无异常"
            description="观察窗口正常。"
            compact
          />
        ) : (
          <div className="grid gap-3">
            {anomalies.map((item) => (
              <div
                key={item.id}
                className="grid gap-1 rounded-lg border border-border/60 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{item.title}</div>
                  <Badge variant={anomalyBadgeVariant(item.severity)}>
                    {anomalySeverityLabel(item.severity)}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  {item.description}
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.date || item.targetName || item.metric}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DailyBreakdownCard({
  modelRows,
  onSelectDate,
  rows,
  selectedDate,
  tenantRows,
}: {
  modelRows: DailyDimensionUsageStatsRow[];
  onSelectDate: (date: string) => void;
  rows: DailyUsageStatsRow[];
  selectedDate: string;
  tenantRows: DailyDimensionUsageStatsRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>每日明细矩阵</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无每日明细"
            description="等待请求。"
            compact
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>请求 / 错误</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>缓存</TableHead>
                <TableHead>延迟</TableHead>
                <TableHead>Top 租户 / 模型</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...rows].reverse().map((row) => {
                const topTenant = topDimensionForDate(tenantRows, row.date);
                const topModel = topDimensionForDate(modelRows, row.date);
                const selected = row.date === selectedDate;
                return (
                  <TableRow
                    key={row.date}
                    data-state={selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelectDate(row.date)}
                  >
                    <TableCell>
                      <div className="font-medium">{row.date}</div>
                      {dailyAnomalyLabels(row).map((label) => (
                        <Badge key={label} className="mt-1 mr-1" variant="outline">
                          {label}
                        </Badge>
                      ))}
                    </TableCell>
                    <TableCell>
                      <CountCell row={row} />
                    </TableCell>
                    <TableCell>
                      <TokenCell row={row} />
                    </TableCell>
                    <TableCell>{formatPercent(row.cacheHitRate)}</TableCell>
                    <TableCell>
                      <LatencyCell row={row} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {topTenant?.dimensionName || "-"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {topModel?.dimensionName || "-"}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DailyDimensionTabs({
  channelRows,
  credentialRows,
  errorRows,
  modelRows,
  requestTypeRows,
  selectedDate,
  tenantRows,
}: {
  channelRows: DailyDimensionUsageStatsRow[];
  credentialRows: DailyDimensionUsageStatsRow[];
  errorRows: AdminOverviewStats["byErrorCodeDay"];
  modelRows: DailyDimensionUsageStatsRow[];
  requestTypeRows: DailyDimensionUsageStatsRow[];
  selectedDate: string;
  tenantRows: DailyDimensionUsageStatsRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{selectedDate} 维度钻取</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="tenant">
          <TabsList className="flex w-full flex-wrap justify-start">
            <TabsTrigger value="tenant">租户</TabsTrigger>
            <TabsTrigger value="model">模型</TabsTrigger>
            <TabsTrigger value="channel">通道</TabsTrigger>
            <TabsTrigger value="credential">凭据</TabsTrigger>
            <TabsTrigger value="request">请求类型</TabsTrigger>
            <TabsTrigger value="error">错误码</TabsTrigger>
          </TabsList>
          <TabsContent value="tenant">
            <DailyDimensionTable rows={rowsForDate(tenantRows, selectedDate)} />
          </TabsContent>
          <TabsContent value="model">
            <DailyDimensionTable rows={rowsForDate(modelRows, selectedDate)} />
          </TabsContent>
          <TabsContent value="channel">
            <DailyDimensionTable rows={rowsForDate(channelRows, selectedDate)} />
          </TabsContent>
          <TabsContent value="credential">
            <DailyDimensionTable rows={rowsForDate(credentialRows, selectedDate)} />
          </TabsContent>
          <TabsContent value="request">
            <DailyDimensionTable
              rows={rowsForDate(requestTypeRows, selectedDate)}
            />
          </TabsContent>
          <TabsContent value="error">
            <DailyErrorCodeTable rows={errorRows.filter((row) => row.date === selectedDate)} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function DailyDimensionTable({ rows }: { rows: DailyDimensionUsageStatsRow[] }) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={GaugeIcon}
        title="暂无当天维度数据"
        description="该日期没有对应维度的聚合数据。"
        compact
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>请求数</TableHead>
          <TableHead>成功率</TableHead>
          <TableHead>Token 占比</TableHead>
          <TableHead>Token</TableHead>
          <TableHead>延迟</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 12).map((row, index) => (
          <TableRow key={`${row.date}:${row.dimension}:${row.key}:${index}`}>
            <TableCell>
              <div className="font-medium">{row.dimensionName}</div>
              {row.dimensionId && (
                <div className="text-xs text-muted-foreground">
                  {row.dimensionId}
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
              <Progress value={maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0} />
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
  );
}

function DailyErrorCodeTable({
  rows,
}: {
  rows: AdminOverviewStats["byErrorCodeDay"];
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheckIcon}
        title="当天没有错误码"
        description="该日期没有记录到错误请求。"
        compact
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>错误码</TableHead>
          <TableHead>次数</TableHead>
          <TableHead>租户</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 20).map((row, index) => (
          <TableRow key={`${row.date}:${row.errorCode}:${row.tenantId}:${index}`}>
            <TableCell>
              <Badge variant="destructive">{row.errorCode}</Badge>
            </TableCell>
            <TableCell>{formatNumber(row.requestCount)}</TableCell>
            <TableCell>{row.tenantName || row.tenantId || "未归属流量"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function rowsForDate(
  rows: DailyDimensionUsageStatsRow[],
  date: string,
): DailyDimensionUsageStatsRow[] {
  return rows
    .filter((row) => row.date === date)
    .toSorted(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        right.requestCount - left.requestCount,
    );
}

function topDimensionForDate(
  rows: DailyDimensionUsageStatsRow[],
  date: string,
) {
  return rowsForDate(rows, date)[0] || null;
}

function dailyAnomalyLabels(row: DailyUsageStatsRow) {
  const labels: string[] = [];
  const errorRate = ratio(row.errorCount, row.requestCount) || 0;
  if (errorRate >= 15) {
    labels.push("错误严重");
  } else if (errorRate >= 5) {
    labels.push("错误偏高");
  }
  if (row.avgLatencyMs >= 10_000) {
    labels.push("延迟偏高");
  }
  return labels;
}

function anomalyBadgeVariant(
  severity: AdminOverviewStats["anomalies"][number]["severity"],
) {
  return severity === "critical"
    ? "destructive"
    : severity === "warning"
      ? "outline"
      : "secondary";
}

function anomalySeverityLabel(
  severity: AdminOverviewStats["anomalies"][number]["severity"],
) {
  const labels: Record<
    AdminOverviewStats["anomalies"][number]["severity"],
    string
  > = {
    critical: "严重",
    warning: "关注",
    info: "提示",
  };
  return labels[severity];
}

function TenantUsageCard({ rows }: { rows: TenantUsageStatsRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>租户消耗</CardTitle>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 个租户</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="暂无租户使用统计"
            description="等待租户流量。"
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
  emptyTitle,
  rows,
  title,
}: {
  emptyTitle: string;
  rows: UsageStatsRow[];
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 行</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="等待请求。"
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
  const tokenChange = percentChange(today.avgTokensPerRequest, yesterday.avgTokensPerRequest);
  const latencyChange = percentChange(today.p95FirstTokenLatencyMs, yesterday.p95FirstTokenLatencyMs);
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
      title: "每请求 Token",
      value: formatTokenNumber(today.avgTokensPerRequest),
      description: `缓存节省 ${formatTokenNumber(today.cachedTokens)} · 命中 ${formatPercent(today.cacheHitRate)}`,
      changeLabel: formatChangePercent(tokenChange.value),
      direction: tokenChange.direction,
      tone: directionTone(tokenChange.direction),
      data: days.map((row) => ({ date: row.date, value: row.avgTokensPerRequest })),
      icon: DatabaseIcon,
    },
    {
      title: "P95 首 Token",
      value: formatDuration(today.p95FirstTokenLatencyMs),
      description: `P95 总延迟 ${formatDuration(today.p95LatencyMs)} · ${formatTokenNumber(Math.round(today.tokensPerSecond))} token/秒`,
      changeLabel: formatChangePercent(latencyChange.value),
      direction: latencyChange.direction,
      tone: directionTone(latencyChange.direction, { lowerIsBetter: true }),
      data: days.map((row) => ({
        date: row.date,
        value: row.p95FirstTokenLatencyMs,
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
  return instantToDateKey(new Date(), getDisplayTimeZone());
}

function addUtcDays(dateKey: string, deltaDays: number) {
  return addDateKeyDays(dateKey, deltaDays);
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
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Icon className="size-3.5" />
              {title}
            </div>
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

function UsageListCard({
  title,
  emptyTitle,
  rows,
}: {
  title: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="等待请求。"
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
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无每日统计"
            description="等待请求。"
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

function supportedTimeZones() {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const values = intl.supportedValuesOf?.("timeZone") || [
    "Africa/Cairo",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/New_York",
    "America/Sao_Paulo",
    "Asia/Dubai",
    "Asia/Hong_Kong",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Europe/Berlin",
    "Europe/London",
    "Europe/Paris",
    "Pacific/Auckland",
    "UTC",
  ];
  return [...new Set(["Asia/Shanghai", ...values])].sort((left, right) =>
    left.localeCompare(right),
  );
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
  const date = parseInstant(value);
  return (
    <time dateTime={date?.toISOString()} suppressHydrationWarning>
      {isClient ? formatDateTime(value) : "-"}
    </time>
  );
}

function subscribeNoop() {
  return () => undefined;
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

