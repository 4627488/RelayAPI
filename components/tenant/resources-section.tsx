"use client";

import * as React from "react";
import {
  GaugeIcon,
  NetworkIcon,
  RefreshCwIcon,
  UserRoundIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  formatDateTime,
  formatNumber,
  renderBadgeList,
} from "@/components/dashboard/format";
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
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type {
  CodexQuotaReport,
  CodexResetCreditsReport,
} from "@/lib/admin-api";
import {
  getTenantCredentialQuota,
  getTenantCredentialResetCredits,
  tenantErrorMessage,
} from "@/lib/tenant-api";
import type {
  PublicTenant,
  TenantResourceCredential,
  TenantResources,
} from "@/src/shared/types/entities";

export function TenantResourcesSection({
  resources,
  tenant,
}: {
  resources: TenantResources;
  tenant: PublicTenant;
}) {
  const credentialsById = React.useMemo(
    () => new Map(resources.credentials.map((item) => [item.id, item])),
    [resources.credentials],
  );

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>授权模型</CardTitle>
          <CardDescription>Key 可从这些模型中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-muted/35 p-3">
            {renderBadgeList(resources.models, "管理员未限制模型")}
          </div>
        </CardContent>
      </Card>

      <TenantCredentialsPanel credentials={resources.credentials} />

      <Card>
        <CardHeader>
          <CardTitle>授权通道</CardTitle>
          <CardDescription>Key 可从这些通道中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {resources.channels.length === 0 ? (
            <Empty className="col-span-full min-h-44">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NetworkIcon />
                </EmptyMedia>
                <EmptyTitle>暂无授权通道</EmptyTitle>
                <EmptyDescription>
                  {tenant.channelAllowlist.length === 0
                    ? "管理员未限制通道。"
                    : "暂无可用授权通道。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            resources.channels.map((channel) => (
              <div
                key={channel.id}
                className="rounded-lg border bg-background/60 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{channel.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {channel.id}
                    </div>
                  </div>
                  <Badge variant={channel.enabled ? "secondary" : "outline"}>
                    {channel.status}
                  </Badge>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  {renderBadgeList(channel.modelAllowlist, "全部模型")}
                </div>
                <div className="mt-3 grid gap-1.5 text-xs">
                  <div className="text-muted-foreground">绑定凭据</div>
                  <div className="flex flex-wrap gap-1">
                    {channel.credentialIds.length === 0 ? (
                      <Badge variant="outline">未绑定</Badge>
                    ) : (
                      channel.credentialIds.map((id) => {
                        const credential = credentialsById.get(id);
                        return (
                          <Badge key={id} variant="outline">
                            {credentialLabel(credential) || id}
                          </Badge>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TenantCredentialsPanel({
  credentials,
}: {
  credentials: TenantResourceCredential[];
}) {
  const [quotaLoadingIds, setQuotaLoadingIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [quotas, setQuotas] = React.useState<Record<string, CodexQuotaReport>>(
    {},
  );
  const [quotaErrors, setQuotaErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [resetCredits, setResetCredits] = React.useState<
    Record<string, CodexResetCreditsReport>
  >({});
  const [resetCreditErrors, setResetCreditErrors] = React.useState<
    Record<string, string>
  >({});
  const [refreshingAll, setRefreshingAll] = React.useState(false);
  const quotaLoadRequestedRef = React.useRef(new Set<string>());

  const setQuotaLoading = React.useCallback((id: string, loading: boolean) => {
    setQuotaLoadingIds((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const loadQuota = React.useCallback(
    async (
      credential: TenantResourceCredential,
      options: { forceRefresh?: boolean; silent?: boolean } = {},
    ) => {
      const forceRefresh = options.forceRefresh ?? false;
      setQuotaLoading(credential.id, true);
      setQuotaErrors((current) => {
        if (!(credential.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[credential.id];
        return next;
      });
      setResetCreditErrors((current) => {
        if (!(credential.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[credential.id];
        return next;
      });

      try {
        const [quotaResult, resetCreditsResult] = await Promise.allSettled([
          getTenantCredentialQuota(credential.id, { refresh: forceRefresh }),
          getTenantCredentialResetCredits(credential.id),
        ]);
        if (resetCreditsResult.status === "fulfilled") {
          setResetCredits((current) => ({
            ...current,
            [credential.id]: resetCreditsResult.value,
          }));
        } else {
          setResetCreditErrors((current) => ({
            ...current,
            [credential.id]: tenantErrorMessage(resetCreditsResult.reason),
          }));
        }
        if (quotaResult.status === "rejected") {
          throw quotaResult.reason;
        }
        const quota = quotaResult.value;
        setQuotas((current) => ({ ...current, [credential.id]: quota }));
        if (!options.silent) {
          toast.success(forceRefresh ? "额度已刷新" : "额度已读取");
        }
        return true;
      } catch (error) {
        const message = tenantErrorMessage(error);
        setQuotaErrors((current) => ({ ...current, [credential.id]: message }));
        if (!options.silent) {
          toast.error(message);
        }
        return false;
      } finally {
        setQuotaLoading(credential.id, false);
      }
    },
    [setQuotaLoading],
  );

  const refreshAllQuotas = React.useCallback(async () => {
    if (credentials.length === 0) {
      return;
    }

    setRefreshingAll(true);
    try {
      const results = await Promise.all(
        credentials.map((credential) =>
          loadQuota(credential, { forceRefresh: true, silent: true }),
        ),
      );
      const failedCount = results.filter((success) => !success).length;
      if (failedCount > 0) {
        toast.error(`额度刷新完成，${formatNumber(failedCount)} 个账号失败`);
      } else {
        toast.success("全部额度已刷新");
      }
    } finally {
      setRefreshingAll(false);
    }
  }, [credentials, loadQuota]);

  React.useEffect(() => {
    credentials.forEach((credential) => {
      if (quotaLoadRequestedRef.current.has(credential.id)) {
        return;
      }
      quotaLoadRequestedRef.current.add(credential.id);
      void loadQuota(credential, { silent: true });
    });
  }, [credentials, loadQuota]);

  const quotaPending = refreshingAll || quotaLoadingIds.size > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>授权凭据</CardTitle>
        <CardDescription>
          当前租户可用通道绑定的 Codex 账号、健康状态和额度。
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            disabled={credentials.length === 0 || quotaPending}
            onClick={refreshAllQuotas}
          >
            {quotaPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新全部额度
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {credentials.length === 0 ? (
          <Empty className="min-h-44">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserRoundIcon />
              </EmptyMedia>
              <EmptyTitle>暂无授权凭据</EmptyTitle>
              <EmptyDescription>
                授权通道绑定凭据后，这里会显示账号和额度。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {credentials.map((credential) => (
              <CredentialCard
                key={credential.id}
                credential={credential}
                errorMessage={quotaErrors[credential.id]}
                loading={quotaLoadingIds.has(credential.id)}
                quota={quotas[credential.id]}
                onRefresh={() =>
                  void loadQuota(credential, { forceRefresh: true })
                }
                resetCreditError={resetCreditErrors[credential.id]}
                resetCredits={resetCredits[credential.id]}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CredentialCard({
  credential,
  errorMessage,
  loading,
  onRefresh,
  quota,
  resetCreditError,
  resetCredits,
}: {
  credential: TenantResourceCredential;
  errorMessage?: string;
  loading: boolean;
  onRefresh: () => void;
  quota: CodexQuotaReport | undefined;
  resetCreditError?: string;
  resetCredits?: CodexResetCreditsReport;
}) {
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {codexPlanLabel(credential.planType)}
            </Badge>
            <Badge variant={credential.enabled ? "secondary" : "outline"}>
              {credential.enabled ? "启用" : "停用"}
            </Badge>
            {credential.fastEnabled && <Badge variant="outline">Fast</Badge>}
            {credential.cooldownUntil && (
              <Badge variant="outline">冷却中</Badge>
            )}
          </div>
          <div className="truncate text-base font-medium">
            {credentialLabel(credential) || "未知账号"}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          刷新
        </Button>
      </div>
      <div className="grid gap-3 text-sm">
        <InfoLine label="账号 ID" value={credential.accountId || "-"} mono />
        <InfoLine
          label="路由"
          value={`优先级 ${formatNumber(credential.priority)} · 权重 ${formatNumber(credential.weight)} · ${credentialUpstreamTransportText(credential.upstreamTransport)}`}
        />
        <InfoLine
          label="代理"
          value={
            credential.proxy?.enabled
              ? `${credential.proxy.type}://${credential.proxy.host}:${credential.proxy.port}`
              : credential.useGlobalProxy
                ? "使用全局代理"
                : "直连"
          }
        />
        <InfoLine
          label="过期时间"
          value={formatNullableDate(credential.expiresAt)}
        />
        <InfoLine
          label="最近刷新"
          value={formatNullableDate(credential.lastRefreshAt)}
        />
        <InfoLine
          label="最近使用"
          value={formatNullableDate(credential.lastUsedAt)}
        />
        {credential.cooldownUntil && (
          <InfoLine
            label="冷却至"
            value={formatNullableDate(credential.cooldownUntil)}
          />
        )}
        {credential.usageHealth && (
          <div className="grid gap-1 rounded-lg border border-border/60 bg-background/60 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">凭据健康度</span>
              <span className="tabular-nums">
                {formatNumber(credential.usageHealth.score)}%
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              最近 {formatNumber(credential.usageHealth.windowSize)} 次 · 成功{" "}
              {formatNumber(credential.usageHealth.successCount)} · 错误{" "}
              {formatNumber(credential.usageHealth.errorCount)}
            </div>
          </div>
        )}
        {credential.lastError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {credential.lastError}
          </div>
        )}
        <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted-foreground">
              <GaugeIcon />
              剩余额度
            </span>
            {quota && <QuotaSummaryBadge quota={quota} />}
          </div>
          <QuotaProgressCell
            errorMessage={errorMessage}
            loading={loading}
            quota={quota}
            resetCreditError={resetCreditError}
            resetCredits={resetCredits}
          />
        </div>
      </div>
    </div>
  );
}

function InfoLine({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "truncate font-mono text-xs" : "truncate"}>
        {value}
      </span>
    </div>
  );
}

function QuotaSummaryBadge({ quota }: { quota: CodexQuotaReport }) {
  if (quota.status === "not_cached" || quota.status === "unknown") {
    return <Badge variant="outline">{quotaStatusLabel(quota.status)}</Badge>;
  }
  if (quota.status === "exhausted" || quota.status === "low") {
    return (
      <Badge variant="destructive">{quotaStatusLabel(quota.status)}</Badge>
    );
  }
  return <Badge variant="secondary">{quotaStatusLabel(quota.status)}</Badge>;
}

function QuotaProgressCell({
  errorMessage,
  loading,
  quota,
  resetCreditError,
  resetCredits,
}: {
  errorMessage?: string;
  loading: boolean;
  quota: CodexQuotaReport | undefined;
  resetCreditError?: string;
  resetCredits?: CodexResetCreditsReport;
}) {
  if (!quota) {
    if (errorMessage) {
      return <span className="text-xs text-destructive">{errorMessage}</span>;
    }

    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {loading ? (
          <>
            <Spinner data-icon="inline-start" />
            读取中
          </>
        ) : (
          <Badge variant="outline">未读取</Badge>
        )}
      </div>
    );
  }

  const windows = [...quota.windows, ...quota.additional_windows];

  if (windows.length === 0) {
    return (
      <div className="grid gap-1">
        <ResetCreditsLine
          errorMessage={resetCreditError}
          loading={loading}
          resetCredits={resetCredits}
        />
        <span className="text-xs text-muted-foreground">
          {quota.message || "没有可展示的额度窗口"}
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <ResetCreditsLine
        errorMessage={resetCreditError}
        loading={loading}
        resetCredits={resetCredits}
      />
      {windows.map((window, index) => {
        const remainingPercent = window.remaining_percent;
        const progressValue =
          remainingPercent === null ? 0 : clamp(remainingPercent, 0, 100);

        return (
          <div key={`${window.id}-${index}`} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                {window.label}
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {window.reset_label || "-"}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Progress
                className="min-w-0 flex-1 **:data-[slot=progress-track]:h-2"
                value={progressValue}
              />
              <span
                className={
                  window.exhausted
                    ? "w-9 shrink-0 text-right text-xs tabular-nums text-destructive"
                    : "w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                }
              >
                {remainingPercent === null
                  ? "未知"
                  : `${Math.round(remainingPercent)}%`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ResetCreditsLine({
  errorMessage,
  loading,
  resetCredits,
}: {
  errorMessage?: string;
  loading: boolean;
  resetCredits?: CodexResetCreditsReport;
}) {
  if (resetCredits) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/50 px-2 py-1.5 text-xs">
        <span className="text-muted-foreground">重置次数</span>
        <Badge
          variant={resetCredits.available_count > 0 ? "secondary" : "outline"}
        >
          {formatNumber(resetCredits.available_count)} 次
        </Badge>
      </div>
    );
  }
  if (errorMessage) {
    return (
      <div className="text-xs text-amber-600 dark:text-amber-300">
        重置次数读取失败
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground">
      {loading ? "重置次数读取中" : "重置次数未读取"}
    </div>
  );
}

function credentialLabel(credential: TenantResourceCredential | undefined) {
  if (!credential) {
    return "";
  }
  return credential.email || credential.accountId || credential.id;
}

function codexPlanLabel(planType: string) {
  const key = planType.trim().toLowerCase();
  if (key.includes("pro 20")) {
    return "Pro 20x";
  }
  if (key.includes("pro")) {
    return "Pro";
  }
  if (key.includes("plus")) {
    return "Plus";
  }
  if (key.includes("free")) {
    return "Free";
  }
  return planType || "Unknown";
}

function credentialUpstreamTransportText(
  transport: TenantResourceCredential["upstreamTransport"],
) {
  return transport === "websocket" ? "WebSocket" : "HTTP";
}

function quotaStatusLabel(status: CodexQuotaReport["status"]) {
  const labels: Record<CodexQuotaReport["status"], string> = {
    unknown: "未知",
    exhausted: "已耗尽",
    low: "偏低",
    medium: "中等",
    high: "充足",
    full: "满额",
    not_cached: "未缓存",
  };
  return labels[status] || status;
}

function formatNullableDate(value: string | null) {
  return value ? formatDateTime(value) : "未记录";
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}
