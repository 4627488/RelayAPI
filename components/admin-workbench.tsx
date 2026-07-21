"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  FileTextIcon,
  GaugeIcon,
  RefreshCwIcon,
  RouteIcon,
  SettingsIcon,
  ShieldCheckIcon,
  WalletCardsIcon,
  XCircleIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { aggregateHourlyTrends } from "@/components/workspace/hourly-trends";
import {
  formatDateTime,
  setDisplayTimeZone,
} from "@/components/workspace/format";
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
import { AdminQuotaSection } from "@/components/admin/quota-section";
import { SubscriptionAllocationSection } from "@/components/admin/subscription-allocation-section";
import { GrokCredentialCards } from "@/components/admin/grok-section";
import { OverviewSection } from "@/components/admin/overview-section";
import {
  adminErrorMessage,
  changeAdminPassword,
  getGlobalSettings,
  getAdminCostAnalysis,
  getOverview,
  getRequestLogsPage,
  listApiKeys,
  listChannels,
  listCredentials,
  listProxyPoolItems,
  listTenants,
  logoutWebSession,
  pruneRequestLogs,
  rotateOidcClientSecret,
  updateGlobalSettings,
  WEB_AUTH_EXPIRED_EVENT,
  type ApiKeyTransferResponse,
  type AdminDashboardRequestLogRow,
  type CostAnalysis,
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
} from "@/src/shared/types/entities";
import {
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
  | "quota"
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
  const [costAnalysis, setCostAnalysis] = React.useState<CostAnalysis | null>(null);
  const [overview24hLogs, setOverview24hLogs] = React.useState<AdminDashboardRequestLogRow[]>([]);
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
    const [stats, costs, hourlyLogs] = await Promise.all([
      getOverview({ days }),
      getAdminCostAnalysis(),
      getRequestLogsPage({
        limit: 500,
        page: 1,
        from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
      }),
    ]);
    setOverviewStats(stats);
    setCostAnalysis(costs);
    setOverview24hLogs(hourlyLogs.data);
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
        section === "overview" || section === "quota" ||
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
      id: "quota",
      label: "份额与成本",
      icon: WalletCardsIcon,
      group: "运营",
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
                costAnalysis={costAnalysis}
                hourlyTrends={aggregateHourlyTrends(overview24hLogs)}
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
                <SubscriptionAllocationSection
                  tenants={tenants}
                />
                <CredentialsSection
                  credentials={credentials}
                  globalSettings={globalSettings}
                  proxyPool={proxyPool}
                  onDeleted={handleCredentialDeleted}
                  onRefreshData={refreshCredentialAndChannelData}
                  onUpdated={handleCredentialUpdated}
                  providerControls={<GrokCredentialCards />}
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
              <div className="flex flex-col gap-3">
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
                key={`${globalSettings.proxySource}:${globalSettings.proxy?.enabled}:${globalSettings.proxy?.type}:${globalSettings.proxy?.host}:${globalSettings.proxy?.port}:${globalSettings.proxy?.username}:${globalSettings.proxy?.passwordSet}:${globalSettings.userAgentSource}:${globalSettings.userAgent}:${globalSettings.fullRequestLoggingEnabled}:${globalSettings.codexAutoDisableRefreshExhausted}:${globalSettings.requestLogRetentionDays}:${globalSettings.requestLogDetailRetentionDays}:${globalSettings.oidcClientId}:${globalSettings.oidcClientSecretSet}:${globalSettings.oidcRedirectUris.join(",")}:${globalSettings.updatedAt}`}
                settings={globalSettings}
                onSaved={setGlobalSettings}
              />
            )}
            {activeSection === "quota" && <AdminQuotaSection />}
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
  const [oidcForm, setOidcForm] = React.useState(() => ({
    clientId: settings.oidcClientId,
    clientSecret: "",
    redirectUris: settings.oidcRedirectUris.join("\n"),
  }));
  const [oidcSaving, setOidcSaving] = React.useState(false);
  const [oidcRotating, setOidcRotating] = React.useState(false);
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

  async function saveOidcSettings() {
    const redirectUris = oidcForm.redirectUris
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!publicBaseUrl.trim()) return toast.error("请先保存公开网站地址，OIDC 将使用它作为 Issuer");
    if (!oidcForm.clientId.trim()) return toast.error("请输入 OIDC Client ID");
    if (!redirectUris.length) return toast.error("请至少填写一个 LibreChat 回调地址");
    setOidcSaving(true);
    try {
      const updated = await updateGlobalSettings({
        oidcClientId: oidcForm.clientId.trim(),
        oidcRedirectUris: redirectUris,
        ...(oidcForm.clientSecret.trim()
          ? { oidcClientSecret: oidcForm.clientSecret.trim() }
          : {}),
      });
      onSaved(updated);
      setOidcForm({
        clientId: updated.oidcClientId,
        clientSecret: "",
        redirectUris: updated.oidcRedirectUris.join("\n"),
      });
      toast.success("LibreChat OIDC 配置已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setOidcSaving(false);
    }
  }

  async function generateOidcSecret() {
    setOidcRotating(true);
    try {
      const result = await rotateOidcClientSecret();
      setOidcForm((current) => ({
        ...current,
        clientSecret: result.clientSecret,
      }));
      toast.success("已生成并保存新 Client Secret，请复制到 LibreChat");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setOidcRotating(false);
    }
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
      <Card>
        <CardHeader>
          <CardTitle>LibreChat 身份认证</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="oidc-issuer">OIDC Issuer</FieldLabel>
              <Input id="oidc-issuer" readOnly value={settings.oidcIssuer} />
              <FieldDescription>
                来自上方“公开网站地址”，LibreChat 的 OPENID_ISSUER 填写此值。
              </FieldDescription>
            </Field>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="oidc-client-id">Client ID</FieldLabel>
                <Input
                  id="oidc-client-id"
                  value={oidcForm.clientId}
                  disabled={oidcSaving || oidcRotating}
                  onChange={(event) =>
                    setOidcForm((current) => ({
                      ...current,
                      clientId: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-client-secret">Client Secret</FieldLabel>
                <Input
                  id="oidc-client-secret"
                  value={oidcForm.clientSecret}
                  disabled={oidcSaving || oidcRotating}
                  placeholder={
                    settings.oidcClientSecretSet
                      ? "已设置；留空保持不变"
                      : "输入或点击生成"
                  }
                  onChange={(event) =>
                    setOidcForm((current) => ({
                      ...current,
                      clientSecret: event.target.value,
                    }))
                  }
                />
                <FieldDescription>
                  生成后的 Secret 只在当前页面显示，刷新后不再回显。
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="oidc-redirect-uris">LibreChat 回调地址</FieldLabel>
              <Textarea
                id="oidc-redirect-uris"
                className="min-h-24 font-mono text-xs"
                value={oidcForm.redirectUris}
                disabled={oidcSaving || oidcRotating}
                placeholder="https://chat.example.com/oauth/openid/callback"
                onChange={(event) =>
                  setOidcForm((current) => ({
                    ...current,
                    redirectUris: event.target.value,
                  }))
                }
              />
              <FieldDescription>
                每行一个地址，必须与 LibreChat 实际回调地址完全一致。
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Button
                type="button"
                variant="outline"
                disabled={oidcSaving || oidcRotating}
                onClick={generateOidcSecret}
              >
                {oidcRotating ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                生成新 Secret
              </Button>
              <Button
                type="button"
                disabled={oidcSaving || oidcRotating}
                onClick={saveOidcSettings}
              >
                {oidcSaving && <Spinner data-icon="inline-start" />}
                保存 OIDC 配置
              </Button>
              <Badge variant={settings.oidcConfigured ? "secondary" : "outline"}>
                {settings.oidcConfigured ? "已配置" : "未完成"}
              </Badge>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
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

