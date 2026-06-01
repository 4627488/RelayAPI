"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CopyIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  NetworkIcon,
  PencilIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
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
import type {
  AdminOverviewStats,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";
import type {
  AdminDashboardRequestLogRow,
  ApiKeyPayload,
  RequestLogsPage,
} from "@/lib/admin-api";
import {
  createTenantApiKey,
  deleteTenantApiKey,
  getTenantOverview,
  getTenantRequestLogsPage,
  getTenantResources,
  getTenantSettings,
  listTenantApiKeys,
  logoutTenantSession,
  TENANT_AUTH_EXPIRED_EVENT,
  tenantErrorMessage,
  updateTenantApiKey,
  updateTenantSettings,
} from "@/lib/tenant-api";

type TenantSectionId = "overview" | "apiKeys" | "logs" | "resources" | "settings";

type TenantDashboardProps = {
  initialTenant: PublicTenant;
  initialApiKeys: PublicApiKey[];
  initialResources: TenantResources;
  initialOverviewStats: AdminOverviewStats;
  initialRequestLogsPage: RequestLogsPage;
  initialNow: number;
};

type TenantNavigationItem = {
  id: TenantSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
  count?: number;
};

type ApiKeyFormState = {
  name: string;
  enabled: boolean;
  scopes: string;
  modelAllowlist: string;
  channelAllowlist: string;
  tokenLimitDaily: string;
  rateLimitPerMinute: string;
  expiresAt: string;
};

const EMPTY_API_KEY_FORM: ApiKeyFormState = {
  name: "",
  enabled: true,
  scopes: "relay",
  modelAllowlist: "",
  channelAllowlist: "",
  tokenLimitDaily: "",
  rateLimitPerMinute: "",
  expiresAt: "",
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
  const [requestLogs, setRequestLogs] = React.useState(
    initialRequestLogsPage.data,
  );
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

  async function refreshCurrentSection() {
    setRefreshing(true);
    try {
      if (activeSection === "overview") {
        setOverviewStats(await getTenantOverview());
      } else if (activeSection === "apiKeys") {
        setApiKeys(await listTenantApiKeys());
      } else if (activeSection === "logs") {
        const page = await getTenantRequestLogsPage({
          limit: initialRequestLogsPage.limit,
          page: 1,
        });
        setRequestLogs(page.data);
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

  const navigationItems: TenantNavigationItem[] = [
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
      id: "logs",
      label: "日志",
      description: "请求记录",
      icon: FileTextIcon,
      count: requestLogs.length,
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
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto flex w-full max-w-420 flex-col gap-6 px-4 py-6 sm:px-6 2xl:px-10">
        <header className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {tenant.name}
              </h1>
              <Badge variant={tenant.enabled ? "secondary" : "destructive"}>
                {tenant.enabled ? "启用" : "停用"}
              </Badge>
            </div>
            <p className="max-w-4xl text-sm text-muted-foreground">
              租户面板仅显示自己的密钥、日志、资源和设置，所有请求受管理员配置的租户总池限制。
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-2 sm:justify-end">
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
                variant="outline"
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
            </div>
            <p className="text-xs text-muted-foreground">
              数据快照：{formatDateTime(new Date(snapshotTime).toISOString())}
            </p>
          </div>
        </header>

        {sessionExpired && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>租户会话已过期</AlertTitle>
            <AlertDescription>请刷新页面后重新登录。</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border bg-card p-2 shadow-sm lg:sticky lg:top-6">
            <nav className="grid gap-1">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeSection;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    ].join(" ")}
                    onClick={() => setActiveSection(item.id)}
                  >
                    <Icon className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-none">
                        {item.label}
                      </span>
                      <span
                        className={[
                          "mt-1 block text-xs leading-none",
                          active
                            ? "text-primary-foreground/75"
                            : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {item.description}
                      </span>
                    </span>
                    {typeof item.count === "number" && (
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 text-xs tabular-nums",
                          active
                            ? "bg-primary-foreground/15 text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        {formatNumber(item.count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <Separator className="my-2" />
            <div className="grid gap-2 px-3 py-2 text-xs text-muted-foreground">
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
            </div>
          </aside>

          <section className="min-w-0">
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
            {activeSection === "logs" && (
              <TenantLogsSection
                initialPage={initialRequestLogsPage}
                logs={requestLogs}
                onLoaded={setRequestLogs}
              />
            )}
            {activeSection === "resources" && (
              <TenantResourcesSection resources={resources} tenant={tenant} />
            )}
            {activeSection === "settings" && (
              <TenantSettingsSection tenant={tenant} onSaved={setTenant} />
            )}
          </section>
        </div>
      </div>

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
    </main>
  );
}

function TenantOverviewSection({
  stats,
  tenant,
}: {
  stats: AdminOverviewStats;
  tenant: PublicTenant;
}) {
  const totals = stats.totals;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="请求" value={formatNumber(totals.requestCount)} />
        <MetricCard title="成功率" value={formatPercent(totals.successCount, totals.requestCount)} />
        <MetricCard title="Token" value={formatTokenNumber(totals.totalTokens)} />
        <MetricCard title="活跃 Key" value={formatNumber(totals.distinctApiKeyCount)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>租户总池</CardTitle>
          <CardDescription>所有 Key 合计不能超过管理员配置的限制。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <LimitLine label="Key 数" value={tenant.apiKeyCount} limit={tenant.maxApiKeys} />
          <LimitLine label="今日 token" value={tenant.todayTokens} limit={tenant.tokenLimitDaily} />
          <LimitLine label="每分钟请求" value={0} limit={tenant.rateLimitPerMinute} hideValue />
        </CardContent>
      </Card>
    </div>
  );
}

function TenantApiKeysSection({
  apiKeys,
  resources,
  onCreate,
  onDelete,
  onEdit,
}: {
  apiKeys: PublicApiKey[];
  resources: TenantResources;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onEdit: (apiKey: PublicApiKey) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>API 密钥</CardTitle>
          <CardDescription>租户 Key 只能使用已授权的模型和通道。</CardDescription>
        </div>
        <Button type="button" onClick={onCreate}>
          <KeyRoundIcon data-icon="inline-start" />
          新建 Key
        </Button>
      </CardHeader>
      <CardContent>
        {apiKeys.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无 API 密钥</EmptyTitle>
              <EmptyDescription>创建第一个 Key 后即可接入 Relay。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey) => (
                <TableRow key={apiKey.id}>
                  <TableCell className="font-medium">{apiKey.name}</TableCell>
                  <TableCell className="font-mono text-xs">{apiKey.prefix}</TableCell>
                  <TableCell>{renderList(apiKey.modelAllowlist, "全部授权模型")}</TableCell>
                  <TableCell>
                    {renderList(
                      apiKey.channelAllowlist.map(
                        (id) =>
                          resources.channels.find((channel) => channel.id === id)
                            ?.name || id,
                      ),
                      "全部授权通道",
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={apiKey.enabled ? "secondary" : "outline"}>
                      {apiKey.enabled ? "启用" : "停用"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onEdit(apiKey)}
                        aria-label="编辑 API 密钥"
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onDelete(apiKey.id)}
                        aria-label="删除 API 密钥"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
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

function TenantLogsSection({
  initialPage,
  logs,
  onLoaded,
}: {
  initialPage: RequestLogsPage;
  logs: AdminDashboardRequestLogRow[];
  onLoaded: (logs: AdminDashboardRequestLogRow[]) => void;
}) {
  const [loading, setLoading] = React.useState(false);

  async function load() {
    setLoading(true);
    try {
      const page = await getTenantRequestLogsPage({
        limit: initialPage.limit,
        page: 1,
      });
      onLoaded(page.data);
      toast.success("日志已刷新");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>请求日志</CardTitle>
          <CardDescription>仅包含当前租户 Key 发起的请求。</CardDescription>
        </div>
        <Button type="button" variant="outline" disabled={loading} onClick={load}>
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          刷新
        </Button>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无请求日志</EmptyTitle>
              <EmptyDescription>当租户 Key 产生请求后会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">Token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell>{formatDateTime(log.started_at)}</TableCell>
                  <TableCell>{log.api_key_name || log.api_key_prefix || "未知 Key"}</TableCell>
                  <TableCell>{log.model || "未记录"}</TableCell>
                  <TableCell>
                    <Badge variant={log.status_code >= 400 ? "destructive" : "secondary"}>
                      {log.status_code}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokenNumber(log.total_tokens)}
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

function TenantResourcesSection({
  resources,
  tenant,
}: {
  resources: TenantResources;
  tenant: PublicTenant;
}) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>授权模型</CardTitle>
          <CardDescription>Key 可从这些模型中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent>{renderList(resources.models, "管理员未限制模型")}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>授权通道</CardTitle>
          <CardDescription>Key 可从这些通道中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {resources.channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tenant.channelAllowlist.length === 0
                ? "管理员未限制通道。"
                : "暂无可用授权通道。"}
            </p>
          ) : (
            resources.channels.map((channel) => (
              <div key={channel.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{channel.name}</span>
                  <Badge variant={channel.enabled ? "secondary" : "outline"}>
                    {channel.status}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {renderList(channel.modelAllowlist, "全部模型")}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TenantSettingsSection({
  tenant,
  onSaved,
}: {
  tenant: PublicTenant;
  onSaved: (tenant: PublicTenant) => void;
}) {
  const [userAgent, setUserAgent] = React.useState(tenant.userAgent || "");
  const [proxyUrl, setProxyUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload: { userAgent?: string | null; proxy?: string | null } = {};
      if (tenant.allowCustomUserAgent) {
        payload.userAgent = userAgent.trim() || null;
      }
      if (tenant.allowCustomProxy && proxyUrl.trim()) {
        payload.proxy = proxyUrl.trim();
      }
      const saved = await updateTenantSettings(payload);
      onSaved(saved);
      setProxyUrl("");
      toast.success("租户设置已保存");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>租户设置</CardTitle>
        <CardDescription>这些设置只有在管理员允许后才可修改。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tenant-user-agent">User-Agent</FieldLabel>
            <Input
              id="tenant-user-agent"
              disabled={!tenant.allowCustomUserAgent}
              value={userAgent}
              placeholder={
                tenant.allowCustomUserAgent ? "留空使用全局设置" : "管理员未开放"
              }
              onChange={(event) => setUserAgent(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-proxy">SOCKS 代理 URL</FieldLabel>
            <Input
              id="tenant-proxy"
              disabled={!tenant.allowCustomProxy}
              value={proxyUrl}
              placeholder={
                tenant.allowCustomProxy
                  ? "socks5h://user:pass@127.0.0.1:1080"
                  : "管理员未开放"
              }
              onChange={(event) => setProxyUrl(event.target.value)}
            />
            <FieldDescription>
              当前代理：{tenant.proxy ? `${tenant.proxy.type}://${tenant.proxy.host}:${tenant.proxy.port}` : "未配置"}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div>
          <Button
            type="button"
            disabled={
              saving ||
              (!tenant.allowCustomProxy && !tenant.allowCustomUserAgent)
            }
            onClick={save}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存设置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TenantApiKeyDialog({
  apiKey,
  mode,
  onOpenChange,
  onSaved,
  open,
  resources,
}: {
  apiKey?: PublicApiKey | null;
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
  open: boolean;
  resources: TenantResources;
}) {
  const [form, setForm] = React.useState<ApiKeyFormState>(() =>
    apiKey ? apiKeyToForm(apiKey) : EMPTY_API_KEY_FORM,
  );
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = apiKeyFormToPayload(form);
      const saved =
        mode === "create"
          ? await createTenantApiKey(payload)
          : await updateTenantApiKey(assertApiKey(apiKey).id, payload);
      onSaved(saved);
      onOpenChange(false);
      toast.success(mode === "create" ? "API 密钥已创建" : "API 密钥已保存");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "新建租户 API 密钥" : "编辑租户 API 密钥"}
            </DialogTitle>
            <DialogDescription>
              模型和通道只能从管理员授权范围内选择。
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend>密钥配置</FieldLegend>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="tenant-api-key-name">名称</FieldLabel>
                <Input
                  id="tenant-api-key-name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <div>
                  <FieldLabel htmlFor="tenant-api-key-enabled">
                    启用密钥
                  </FieldLabel>
                  <FieldDescription>
                    关闭后，客户端会立即无法使用这个 Key。
                  </FieldDescription>
                </div>
                <Switch
                  id="tenant-api-key-enabled"
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      enabled: Boolean(checked),
                    }))
                  }
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="tenant-api-key-token-limit">
                    每日 token 上限
                  </FieldLabel>
                  <Input
                    id="tenant-api-key-token-limit"
                    inputMode="numeric"
                    placeholder="留空表示仅受租户总池限制"
                    value={form.tokenLimitDaily}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        tokenLimitDaily: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tenant-api-key-rate-limit">
                    每分钟请求限制
                  </FieldLabel>
                  <Input
                    id="tenant-api-key-rate-limit"
                    inputMode="numeric"
                    placeholder="留空表示仅受租户总池限制"
                    value={form.rateLimitPerMinute}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        rateLimitPerMinute: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="tenant-api-key-expires-at">
                  过期时间
                </FieldLabel>
                <Input
                  id="tenant-api-key-expires-at"
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      expiresAt: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-api-key-scopes">权限范围</FieldLabel>
                <Textarea
                  id="tenant-api-key-scopes"
                  value={form.scopes}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scopes: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-api-key-models">
                  模型白名单
                </FieldLabel>
                <Textarea
                  id="tenant-api-key-models"
                  value={form.modelAllowlist}
                  placeholder={
                    resources.models.length > 0
                      ? resources.models.join("\n")
                      : "留空表示全部授权模型"
                  }
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      modelAllowlist: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel>通道白名单</FieldLabel>
                <TenantChannelSelector
                  resources={resources}
                  selectedIds={parseList(form.channelAllowlist)}
                  onSelectedIdsChange={(ids) =>
                    setForm((current) => ({
                      ...current,
                      channelAllowlist: ids.join("\n"),
                    }))
                  }
                />
                <FieldDescription>
                  不选任何通道表示使用全部授权通道。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {mode === "create" ? "创建密钥" : "保存配置"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TenantChannelSelector({
  onSelectedIdsChange,
  resources,
  selectedIds,
}: {
  resources: TenantResources;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);
  if (resources.channels.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无授权通道。</p>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {resources.channels.map((channel) => {
        const active = selected.has(channel.id);
        return (
          <Button
            key={channel.id}
            type="button"
            variant={active ? "secondary" : "outline"}
            className="h-auto justify-start"
            onClick={() =>
              onSelectedIdsChange(
                active
                  ? selectedIds.filter((id) => id !== channel.id)
                  : [...selectedIds, channel.id],
              )
            }
          >
            <span className="truncate">{channel.name}</span>
          </Button>
        );
      })}
    </div>
  );
}

function CreatedApiKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: CreatedApiKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  async function copyKey() {
    if (!apiKey?.key) {
      return;
    }
    await navigator.clipboard.writeText(apiKey.key);
    toast.success("密钥已复制");
  }

  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存 API 密钥明文</DialogTitle>
          <DialogDescription>密钥明文只会显示这一次。</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/50 p-3 font-mono text-sm break-all">
          {apiKey?.key}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copyKey}>
            <CopyIcon data-icon="inline-start" />
            复制
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

function LimitLine({
  hideValue,
  label,
  limit,
  value,
}: {
  label: string;
  value: number;
  limit: number | null;
  hideValue?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="font-medium text-foreground">
        {hideValue ? "上限 " : ""}
        {hideValue ? "" : formatNumber(value)}
        {limit === null ? " / 不限制" : ` / ${formatNumber(limit)}`}
      </span>
    </div>
  );
}

function apiKeyToForm(apiKey: PublicApiKey): ApiKeyFormState {
  return {
    name: apiKey.name,
    enabled: apiKey.enabled,
    scopes: apiKey.scopes.join("\n") || "relay",
    modelAllowlist: apiKey.modelAllowlist.join("\n"),
    channelAllowlist: apiKey.channelAllowlist.join("\n"),
    tokenLimitDaily: apiKey.tokenLimitDaily?.toString() || "",
    rateLimitPerMinute: apiKey.rateLimitPerMinute?.toString() || "",
    expiresAt: toDatetimeLocal(apiKey.expiresAt),
  };
}

function apiKeyFormToPayload(form: ApiKeyFormState): ApiKeyPayload {
  const scopes = parseList(form.scopes);
  return {
    name: form.name.trim() || undefined,
    enabled: form.enabled,
    scopes: scopes.length > 0 ? scopes : ["relay"],
    modelAllowlist: parseList(form.modelAllowlist),
    channelAllowlist: parseList(form.channelAllowlist),
    tokenLimitDaily: nullablePositiveInteger(form.tokenLimitDaily),
    rateLimitPerMinute: nullablePositiveInteger(form.rateLimitPerMinute),
    expiresAt: datetimeLocalToIso(form.expiresAt),
  };
}

function assertApiKey(apiKey: PublicApiKey | null | undefined) {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  return apiKey;
}

function parseList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function nullablePositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function datetimeLocalToIso(value: string) {
  if (!value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDatetimeLocal(value: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function renderList(values: string[], empty: string) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <span className="inline-flex max-w-full flex-wrap gap-1">
      {values.slice(0, 4).map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
      {values.length > 4 && <Badge variant="outline">+{values.length - 4}</Badge>}
    </span>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatTokenNumber(value: number) {
  if (value >= 1_000_000) {
    return `${Math.round(value / 10_000) / 100}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return formatNumber(value);
}

function formatPercent(part: number, total: number) {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((part / total) * 1000) / 10}%`;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "未记录";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}
