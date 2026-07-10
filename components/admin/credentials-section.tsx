"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  UploadIcon,
  UserRoundIcon,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/components/workspace/format";
import { parseInstant } from "@/src/shared/time";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
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
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  adminErrorMessage,
  consumeCredentialResetCredit,
  deleteCredential,
  downloadCredentialsExport,
  finishCodexOAuth,
  getCredentialQuota,
  getCredentialResetCredits,
  importCredentialJson,
  refreshCredential,
  startCodexOAuth,
  updateCredentialRouting,
  type CodexQuotaReport,
  type CodexResetCreditsReport,
  type OAuthStartResponse,
} from "@/lib/admin-api";
import type {
  ChannelRecord,
  CodexCredentialRecord,
  CodexUpstreamTransport,
  CredentialProxyType,
  GlobalSettingsRecord,
  ProxyPoolRecord,
} from "@/src/shared/types/entities";

type CredentialProxyFormState = {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

export function CredentialsSection({
  credentials,
  globalSettings,
  proxyPool,
  onDeleted,
  onRefreshData,
  onUpdated,
}: {
  credentials: CodexCredentialRecord[];
  globalSettings: GlobalSettingsRecord;
  proxyPool: ProxyPoolRecord[];
  onDeleted: (id: string) => void;
  onRefreshData: () => Promise<{
    credentials: CodexCredentialRecord[];
    channels: ChannelRecord[];
  }>;
  onUpdated: (credential: CodexCredentialRecord) => void;
}) {
  const [oauthOpen, setOauthOpen] = React.useState(false);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [uploadingCredential, setUploadingCredential] = React.useState(false);
  const [exportingCredentials, setExportingCredentials] = React.useState(false);
  const credentialFileInputRef = React.useRef<HTMLInputElement>(null);
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
  const [refreshingAllQuotas, setRefreshingAllQuotas] = React.useState(false);
  const [resettingQuotaIds, setResettingQuotaIds] = React.useState<Set<string>>(
    () => new Set(),
  );
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

  async function refreshToken(credential: CodexCredentialRecord) {
    setPendingId(credential.id);
    try {
      const updated = await refreshCredential(credential.id);
      onUpdated(updated);
      toast.success("Codex token 已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
      throw error;
    } finally {
      setPendingId(null);
    }
  }

  const loadQuota = React.useCallback(
    async (
      credential: CodexCredentialRecord,
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
          getCredentialQuota(credential.id, { refresh: forceRefresh }),
          getCredentialResetCredits(credential.id),
        ]);
        if (resetCreditsResult.status === "fulfilled") {
          setResetCredits((current) => ({
            ...current,
            [credential.id]: resetCreditsResult.value,
          }));
        } else {
          setResetCreditErrors((current) => ({
            ...current,
            [credential.id]: adminErrorMessage(resetCreditsResult.reason),
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
        const message = adminErrorMessage(error);
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

    setRefreshingAllQuotas(true);
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
      setRefreshingAllQuotas(false);
    }
  }, [credentials, loadQuota]);

  const redeemResetCredit = React.useCallback(
    async (credential: CodexCredentialRecord) => {
      setResettingQuotaIds((current) => new Set(current).add(credential.id));
      try {
        const result = await consumeCredentialResetCredit(credential.id);
        toast.success(
          result.windows_reset
            ? `已兑换重置，重置 ${formatNumber(result.windows_reset)} 个窗口`
            : "已兑换重置",
        );
        await loadQuota(credential, { forceRefresh: true, silent: true });
      } catch (error) {
        toast.error(adminErrorMessage(error));
      } finally {
        setResettingQuotaIds((current) => {
          const next = new Set(current);
          next.delete(credential.id);
          return next;
        });
      }
    },
    [loadQuota],
  );

  React.useEffect(() => {
    credentials.forEach((credential) => {
      if (quotaLoadRequestedRef.current.has(credential.id)) {
        return;
      }
      quotaLoadRequestedRef.current.add(credential.id);
      void loadQuota(credential, { forceRefresh: false, silent: true });
    });
  }, [credentials, loadQuota]);

  const quotaRefreshPending = refreshingAllQuotas || quotaLoadingIds.size > 0;
  const sortedCredentials = React.useMemo(
    () =>
      [...credentials].sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          right.priority - left.priority ||
          usageHealthScore(right.usageHealth) -
            usageHealthScore(left.usageHealth) ||
          codexPlanRank(right.planType) - codexPlanRank(left.planType),
      ),
    [credentials],
  );

  function openCredentialUpload() {
    credentialFileInputRef.current?.click();
  }

  async function handleCredentialUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    setUploadingCredential(true);
    try {
      const importedCredentials: CodexCredentialRecord[] = [];
      let failedCount = 0;

      for (const file of files) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await file.text()) as unknown;
        } catch (error) {
          failedCount += 1;
          console.error(`Failed to parse credential file ${file.name}`, error);
          continue;
        }

        const payloads = credentialUploadPayloads(parsed);
        if (payloads.length === 0) {
          failedCount += 1;
          continue;
        }

        for (const [index, payload] of payloads.entries()) {
          try {
            const imported = await importCredentialJson(
              payload,
              payloads.length > 1 ? `${file.name}#${index + 1}` : file.name,
            );
            importedCredentials.push(imported);
            quotaLoadRequestedRef.current.add(imported.id);
          } catch (error) {
            failedCount += 1;
            console.error(
              `Failed to import credential from ${file.name}#${index + 1}`,
              error,
            );
          }
        }
      }

      if (importedCredentials.length > 0) {
        await onRefreshData();
        importedCredentials.forEach((credential) => {
          void loadQuota(credential, { forceRefresh: false, silent: true });
        });
      }

      if (importedCredentials.length > 0 && failedCount > 0) {
        toast.error(
          `已上传 ${formatNumber(importedCredentials.length)} 个，失败 ${formatNumber(failedCount)} 个`,
        );
      } else if (importedCredentials.length > 0) {
        toast.success(
          `已上传 ${formatNumber(importedCredentials.length)} 个 Codex 凭据`,
        );
      } else {
        toast.error("没有成功上传的 Codex 凭据");
      }
    } finally {
      setUploadingCredential(false);
    }
  }

  async function exportAllCredentials() {
    setExportingCredentials(true);
    try {
      await downloadCredentialsExport();
      toast.success("Codex 凭据导出已开始");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setExportingCredentials(false);
    }
  }

  async function remove(credential: CodexCredentialRecord) {
    setPendingId(credential.id);
    try {
      await deleteCredential(credential.id);
      onDeleted(credential.id);
      toast.success("Codex 凭据已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
      throw error;
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <input
        ref={credentialFileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        multiple
        onChange={handleCredentialUploadChange}
      />

      <Card>
        <CardHeader>
          <CardTitle>Codex 凭据</CardTitle>
          <CardAction>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={credentials.length === 0 || exportingCredentials}
                onClick={exportAllCredentials}
              >
                {exportingCredentials ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                导出全部
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={credentials.length === 0 || quotaRefreshPending}
                onClick={refreshAllQuotas}
              >
                {quotaRefreshPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新额度
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={uploadingCredential}
                onClick={openCredentialUpload}
              >
                {uploadingCredential ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <UploadIcon data-icon="inline-start" />
                )}
                上传
              </Button>
              <Button type="button" onClick={() => setOauthOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                连接
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UserRoundIcon />
                </EmptyMedia>
                <EmptyTitle>还没有 Codex 凭据</EmptyTitle>
                <EmptyDescription>连接或上传 Codex 凭据。</EmptyDescription>
              </EmptyHeader>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploadingCredential}
                  onClick={openCredentialUpload}
                >
                  {uploadingCredential ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <UploadIcon data-icon="inline-start" />
                  )}
                  上传
                </Button>
                <Button type="button" onClick={() => setOauthOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  连接
                </Button>
              </div>
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {sortedCredentials.map((credential) => {
                const quota = quotas[credential.id];
                const quotaLoading = quotaLoadingIds.has(credential.id);
                const name =
                  credential.email || credential.accountId || "未知账号";
                const refreshStatus = codexTokenRefreshStatus(credential);

                return (
                  <Card
                    key={credential.id}
                    className="relative shadow-sm"
                  >
                    <CardContent className="grid gap-3">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <Badge
                            variant="outline"
                            className={`h-6 shrink-0 px-2 text-sm font-semibold ${codexPlanBadgeTone(credential.planType)}`}
                          >
                            {codexPlanLabel(credential.planType)}
                          </Badge>
                          <div
                            className="min-w-0 flex-1 truncate text-base font-medium"
                            title={name}
                          >
                            {name}
                          </div>
                        </div>
                        <div className="flex shrink-0 justify-end gap-1.5">
                          <CredentialSettingsDialog
                            credential={credential}
                            disabled={pendingId === credential.id}
                            onDeleted={() => remove(credential)}
                            onRefreshToken={() => refreshToken(credential)}
                            onSaved={onUpdated}
                            proxyPool={proxyPool}
                          />
                        </div>
                      </div>

                      {(refreshStatus.exhausted ||
                        refreshStatus.attemptCount > 0 ||
                        refreshStatus.autoDisabled ||
                        !credential.enabled) && (
                        <div className="flex flex-wrap gap-1.5">
                          {!credential.enabled && (
                            <WorkspaceStatusBadge tone="muted">
                              {refreshStatus.autoDisabled
                                ? "auto off"
                                : "off"}
                            </WorkspaceStatusBadge>
                          )}
                          {refreshStatus.exhausted ? (
                            <WorkspaceStatusBadge tone="danger">
                              refresh error
                            </WorkspaceStatusBadge>
                          ) : refreshStatus.attemptCount > 0 ? (
                            <WorkspaceStatusBadge tone="warning">
                              refresh{" "}
                              {formatNumber(refreshStatus.attemptCount)}
                              /3
                            </WorkspaceStatusBadge>
                          ) : null}
                        </div>
                      )}

                      <div className="grid gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-muted-foreground">
                            凭据健康度：
                          </span>
                          {credential.usageHealth ? (
                            <>
                              <UsageHealthBadge
                                status={credential.usageHealth.status}
                              />
                              <span className="tabular-nums text-muted-foreground">
                                {formatNumber(credential.usageHealth.score)}%
                              </span>
                            </>
                          ) : (
                            <WorkspaceStatusBadge tone="muted">
                              unknown
                            </WorkspaceStatusBadge>
                          )}
                        </div>
                        {credential.usageHealth && (
                          <div className="text-xs text-muted-foreground">
                            最近{" "}
                            {formatNumber(credential.usageHealth.windowSize)} 次
                            · 成功{" "}
                            {formatNumber(credential.usageHealth.successCount)}{" "}
                            · 错误{" "}
                            {formatNumber(credential.usageHealth.errorCount)}
                          </div>
                        )}
                        {credential.cooldownUntil && (
                          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-300">
                            <WorkspaceStatusBadge tone="warning">
                              cooldown
                            </WorkspaceStatusBadge>
                            {formatNullableDate(credential.cooldownUntil)}
                          </div>
                        )}
                        {refreshStatus.hasNotice && (
                          <div
                            className={
                              refreshStatus.exhausted
                                ? "text-xs text-destructive"
                                : "text-xs text-amber-600 dark:text-amber-300"
                            }
                          >
                            {refreshStatus.exhausted ? (
                              <>token refresh failed 3/3</>
                            ) : (
                              <>
                                refresh failed{" "}
                                {formatNumber(refreshStatus.attemptCount)}/3
                                {refreshStatus.nextAttemptAt && (
                                  <>
                                    {" · next "}
                                    <LocalDateTime
                                      value={refreshStatus.nextAttemptAt}
                                    />
                                  </>
                                )}
                              </>
                            )}
                            {refreshStatus.lastError && (
                              <> · {refreshStatus.lastError}</>
                            )}
                          </div>
                        )}
                        {credential.lastError && !refreshStatus.hasNotice && (
                          <div className="text-xs text-destructive">
                            {credential.lastError}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          请求代理：
                        </span>
                        <CredentialProxyBadge
                          credential={credential}
                          globalSettings={globalSettings}
                          proxyPool={proxyPool}
                        />
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          过期时间：
                        </span>
                        <span className="min-w-0 truncate">
                          {formatNullableDate(credential.expiresAt)}
                        </span>
                      </div>

                      <div className="grid gap-2 text-sm">
                        <span className="text-muted-foreground">
                          剩余额度：
                        </span>
                        <div className="rounded-lg border border-border/60 bg-muted/35 p-3">
                          <QuotaProgressCell
                            errorMessage={quotaErrors[credential.id]}
                            loading={quotaLoading}
                            onResetCredit={() => redeemResetCredit(credential)}
                            quota={quota}
                            resetCreditError={
                              resetCreditErrors[credential.id]
                            }
                            resetCredits={resetCredits[credential.id]}
                            resetting={resettingQuotaIds.has(credential.id)}
                          />
                        </div>
                      </div>
                    </CardContent>
                    {refreshingAllQuotas && quotaLoading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70 backdrop-blur-[1px]">
                        <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-sm font-medium shadow-sm">
                          <Spinner data-icon="inline-start" />
                          刷新额度中
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <OAuthDialog
        open={oauthOpen}
        onOpenChange={setOauthOpen}
        onCompleted={onRefreshData}
      />
    </>
  );
}

function CredentialRoutingControls({
  credential,
  disabled,
  onSaved,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
}) {
  const [priority, setPriority] = React.useState(
    credential.priority.toString(),
  );
  const [weight, setWeight] = React.useState(credential.weight.toString());
  const [saving, setSaving] = React.useState(false);

  const fastAvailable = isFastCredentialPlan(credential.planType);

  async function saveRouting(patch: {
    enabled?: boolean;
    priority?: number;
    weight?: number;
    fastEnabled?: boolean;
    upstreamTransport?: CodexUpstreamTransport;
  }) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, patch);
      onSaved(updated);
      toast.success("凭据路由配置已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">凭据路由</div>
        </div>
        <Switch
          checked={credential.enabled}
          disabled={disabled || saving}
          size="sm"
          onCheckedChange={(checked) =>
            saveRouting({ enabled: Boolean(checked) })
          }
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">Fast</div>
            <div className="text-xs text-muted-foreground">
              Pro / Pro 20x 可用
            </div>
          </div>
          <Switch
            checked={credential.fastEnabled && fastAvailable}
            disabled={disabled || saving || !fastAvailable}
            size="sm"
            onCheckedChange={(checked) =>
              saveRouting({ fastEnabled: Boolean(checked) })
            }
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">WebSocket</div>
            <div className="text-xs text-muted-foreground">流式 /responses</div>
          </div>
          <Switch
            checked={credential.upstreamTransport === "websocket"}
            disabled={disabled || saving}
            size="sm"
            onCheckedChange={(checked) =>
              saveRouting({
                upstreamTransport: checked ? "websocket" : "http",
              })
            }
          />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input
          aria-label="凭据优先级"
          inputMode="numeric"
          value={priority}
          placeholder="优先级"
          onChange={(event) => setPriority(event.target.value)}
        />
        <Input
          aria-label="凭据权重"
          inputMode="numeric"
          value={weight}
          placeholder="权重"
          onChange={(event) => setWeight(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || saving}
          onClick={() =>
            saveRouting({
              priority: integerValue(priority, credential.priority),
              weight: Math.max(1, integerValue(weight, credential.weight)),
            })
          }
        >
          {saving && <Spinner data-icon="inline-start" />}
          保存
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        当前：优先级 {formatNumber(credential.priority)} · 权重{" "}
        {formatNumber(credential.weight)} · Fast{" "}
        {credential.fastEnabled && fastAvailable ? "开" : "关"} ·{" "}
        {credentialUpstreamTransportText(credential.upstreamTransport)}
      </div>
    </div>
  );
}

function CredentialUserAgentControls({
  credential,
  disabled,
  onSaved,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
}) {
  const [value, setValue] = React.useState(credential.userAgent ?? "");
  const [saving, setSaving] = React.useState(false);

  async function saveUserAgent(userAgent: string | null) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        userAgent,
      });
      onSaved(updated);
      setValue(updated.userAgent ?? "");
      toast.success(
        updated.userAgent
          ? "凭据 User-Agent 已保存"
          : "凭据 User-Agent 已清除，将使用全局设置",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const pending = disabled || saving;

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <div className="font-medium">User-Agent 覆盖</div>
          <div className="text-xs text-muted-foreground">
            留空则使用全局设置。该值会用于此凭据的 Codex 请求和额度刷新。
          </div>
        </div>
        <Badge variant={credential.userAgent ? "secondary" : "outline"}>
          {credential.userAgent ? "凭据自定义" : "使用全局"}
        </Badge>
      </div>
      <Textarea
        className="min-h-20 font-mono text-xs"
        disabled={pending}
        value={value}
        placeholder="使用全局 User-Agent"
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          当前：{credential.userAgent || "使用全局 User-Agent"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !credential.userAgent}
            onClick={() => saveUserAgent(null)}
          >
            {saving && <Spinner data-icon="inline-start" />}
            清除覆盖
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => saveUserAgent(value.trim() || null)}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存 User-Agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function CredentialProxyControls({
  credential,
  disabled,
  onSaved,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
  proxyPool: ProxyPoolRecord[];
}) {
  const [form, setForm] = React.useState(() => credentialProxyForm(credential));
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const proxy = credential.proxy;

  function patchForm(patch: Partial<CredentialProxyFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function saveProxy() {
    const host = form.host.trim();
    const port = integerValue(form.port, 0);
    if (!host) {
      toast.error("请输入 SOCKS5 代理主机");
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
      const updated = await updateCredentialRouting(credential.id, {
        proxy: payload,
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("凭据请求代理已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearProxy() {
    setClearing(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxy: null,
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("凭据请求代理已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  async function saveProxyPoolId(proxyPoolId: string | null) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxyPoolId,
      });
      onSaved(updated);
      toast.success(proxyPoolId ? "已选择代理池代理" : "代理池选择已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUseGlobalProxy(useGlobalProxy: boolean) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        useGlobalProxy,
      });
      onSaved(updated);
      toast.success(
        useGlobalProxy ? "已允许使用全局代理" : "已关闭全局代理回退",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    if (!proxy) {
      return;
    }
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxy: {
          enabled: proxy.enabled,
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: "",
        },
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("代理密码已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const pending = disabled || saving || clearing;

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">请求代理</div>
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

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">使用全局代理</div>
            <div className="text-xs text-muted-foreground">
              无本地/代理池代理时回退
            </div>
          </div>
          <Switch
            checked={credential.useGlobalProxy}
            disabled={pending}
            size="sm"
            onCheckedChange={(checked) => saveUseGlobalProxy(Boolean(checked))}
          />
        </div>
        <label className="grid gap-1 rounded-md border border-border/50 bg-background/50 p-2 text-xs text-muted-foreground">
          代理池
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            value={credential.proxyPoolId ?? ""}
            onChange={(event) =>
              saveProxyPoolId(event.target.value ? event.target.value : null)
            }
          >
            <option value="">不使用代理池</option>
            {proxyPool.map((proxy) => (
              <option key={proxy.id} value={proxy.id}>
                {proxy.name} · {proxy.type}://{proxy.host}:{proxy.port}
                {proxy.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-[0.8fr_1fr_0.7fr]">
        <label className="grid gap-1 text-xs text-muted-foreground">
          协议
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            value={form.type}
            onChange={(event) =>
              patchForm({ type: event.target.value as CredentialProxyType })
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
            onChange={(event) => patchForm({ username: event.target.value })}
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
            onChange={(event) => patchForm({ password: event.target.value })}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          当前：{credentialProxyText(credential)} · 代理池：
          {proxyPoolSelectionText(credential, proxyPool)} · 全局：
          {credential.useGlobalProxy ? "开启" : "关闭"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !proxy?.passwordSet}
            onClick={clearPassword}
          >
            {saving && <Spinner data-icon="inline-start" />}
            清除密码
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !proxy}
            onClick={clearProxy}
          >
            {clearing && <Spinner data-icon="inline-start" />}
            清除代理
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={saveProxy}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存代理
          </Button>
        </div>
      </div>
    </div>
  );
}

function OAuthDialog({
  onCompleted,
  onOpenChange,
  open,
}: {
  onCompleted: () => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [session, setSession] = React.useState<OAuthStartResponse | null>(null);
  const [callbackUrl, setCallbackUrl] = React.useState("");

  async function startOAuth() {
    setPending(true);
    try {
      const started = await startCodexOAuth();
      setSession(started);
      toast.success("OAuth 链接已生成");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function finishOAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = callbackUrl.trim();
    if (!trimmed) {
      toast.error("请粘贴 OAuth callback URL 或 query string");
      return;
    }
    setPending(true);
    try {
      await finishCodexOAuth(trimmed);
      await onCompleted();
      setCallbackUrl("");
      setSession(null);
      onOpenChange(false);
      toast.success("Codex 凭据已连接");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={finishOAuth}>
          <DialogHeader>
            <DialogTitle>连接 Codex 账号</DialogTitle>
            <DialogDescription>
              先生成 OAuth 链接并在浏览器打开，授权完成后把 callback URL 或
              query string 粘贴回来完成保存。
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>OAuth 链接</FieldLabel>
                <FieldDescription>
                  服务端会创建临时 PKCE state，并持久化到数据库以跨进程完成
                  callback。
                </FieldDescription>
              </FieldContent>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={startOAuth}
              >
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlusIcon data-icon="inline-start" />
                )}
                生成链接
              </Button>
            </Field>

            {session && (
              <div className="grid gap-3 rounded-xl border bg-muted/40 p-3">
                <div className="grid gap-1">
                  <div className="text-sm font-medium">Auth URL</div>
                  <Textarea
                    readOnly
                    className="min-h-24"
                    value={session.authUrl}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  Redirect URI：{session.redirectUri}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyText(session.authUrl)}
                  >
                    <CopyIcon data-icon="inline-start" />
                    复制 OAuth 链接
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      window.open(
                        session.authUrl,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    打开链接
                  </Button>
                </div>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor="oauth-callback-url">
                Callback URL 或 query string
              </FieldLabel>
              <Textarea
                id="oauth-callback-url"
                className="min-h-28"
                value={callbackUrl}
                placeholder="http://localhost:3000/api/admin/codex/credentials/oauth/callback?code=...&state=..."
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || !callbackUrl.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              完成连接
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuotaSummaryBadge({ quota }: { quota: CodexQuotaReport }) {
  if (quota.status === "not_cached" || quota.status === "unknown") {
    return (
      <WorkspaceStatusBadge tone="muted">
        {quotaStatusLabel(quota.status)}
      </WorkspaceStatusBadge>
    );
  }
  if (quota.status === "exhausted" || quota.status === "low") {
    return (
      <WorkspaceStatusBadge tone="danger">
        {quotaStatusLabel(quota.status)}
      </WorkspaceStatusBadge>
    );
  }
  return (
    <WorkspaceStatusBadge tone="success">
      {quotaStatusLabel(quota.status)}
    </WorkspaceStatusBadge>
  );
}

function QuotaProgressCell({
  errorMessage,
  loading,
  onResetCredit,
  quota,
  resetCreditError,
  resetCredits,
  resetting,
}: {
  errorMessage?: string;
  loading: boolean;
  onResetCredit?: () => void;
  quota: CodexQuotaReport | undefined;
  resetCreditError?: string;
  resetCredits?: CodexResetCreditsReport;
  resetting?: boolean;
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
          <WorkspaceStatusBadge tone="muted">未读取</WorkspaceStatusBadge>
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
        <QuotaSummaryBadge quota={quota} />
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
                className={`w-9 shrink-0 text-right text-xs tabular-nums ${
                  window.exhausted
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {remainingPercent === null
                  ? "未知"
                  : `${Math.round(remainingPercent)}%`}
              </span>
            </div>
          </div>
        );
      })}
      {onResetCredit && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || resetting}
          onClick={onResetCredit}
        >
          {resetting ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          兑换重置
        </Button>
      )}
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
        <Badge variant={resetCredits.available_count > 0 ? "secondary" : "outline"}>
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

function CredentialSettingsDialog({
  credential,
  disabled,
  onDeleted,
  onRefreshToken,
  onSaved,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onDeleted: () => Promise<void>;
  onRefreshToken: () => Promise<void>;
  onSaved: (credential: CodexCredentialRecord) => void;
  proxyPool: ProxyPoolRecord[];
}) {
  const [open, setOpen] = React.useState(false);
  const [refreshingToken, setRefreshingToken] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const accountName = credential.email || credential.accountId || credential.id;

  async function refreshTokenFromSettings() {
    setRefreshingToken(true);
    try {
      await onRefreshToken();
    } catch {
      // Parent action already shows the concrete error toast.
    } finally {
      setRefreshingToken(false);
    }
  }

  async function exportCredentialFromSettings() {
    setExporting(true);
    try {
      await downloadCredentialsExport(credential.id);
      toast.success("Codex 凭据导出已开始");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="凭据设置"
      >
        <SettingsIcon />
      </Button>
      <DialogContent className="max-h-[88vh] gap-3 overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="pr-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <DialogTitle>凭据设置</DialogTitle>
              <DialogDescription className="mt-1 truncate">
                {accountName}
              </DialogDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {codexPlanLabel(credential.planType)}
              </Badge>
              <Badge variant={credential.enabled ? "secondary" : "outline"}>
                {credential.enabled ? "已启用" : "已禁用"}
              </Badge>
              <Badge variant="outline">
                {credentialUpstreamTransportText(credential.upstreamTransport)}
              </Badge>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="grid h-fit gap-3">
            <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium" title={accountName}>
                  {accountName}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {credential.id}
                </div>
              </div>
              <div className="grid gap-1.5 text-xs text-muted-foreground">
                <CredentialCompactRow label="邮箱" value={credential.email} />
                <CredentialCompactRow
                  label="账号"
                  value={credential.accountId}
                />
                <CredentialCompactRow
                  label="过期"
                  value={formatNullableDate(credential.expiresAt)}
                />
                <CredentialCompactRow
                  label="使用"
                  value={formatNullableDate(credential.lastUsedAt)}
                />
              </div>
            </div>

            <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-start"
                disabled={disabled || refreshingToken}
                onClick={refreshTokenFromSettings}
              >
                {refreshingToken ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新 token
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-start"
                disabled={disabled || exporting}
                onClick={exportCredentialFromSettings}
              >
                {exporting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                导出凭据
              </Button>
              <CredentialDeleteSettingsAction
                credential={credential}
                disabled={disabled}
                onConfirm={onDeleted}
              />
            </div>
          </aside>

          <section className="grid min-w-0 gap-3">
            <CredentialRoutingControls
              key={`${credential.id}:${credential.priority}:${credential.weight}:${credential.enabled}:${credential.fastEnabled}:${credential.upstreamTransport}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
            />

            <CredentialUserAgentControls
              key={`${credential.id}:${credential.userAgent ?? "global"}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
            />

            <CredentialProxyControls
              key={`${credential.id}:${credential.proxyPoolId}:${credential.proxy?.enabled}:${credential.proxy?.type}:${credential.proxy?.host}:${credential.proxy?.port}:${credential.proxy?.username}:${credential.proxy?.passwordSet}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
              proxyPool={proxyPool}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function codexTokenRefreshStatus(credential: CodexCredentialRecord) {
  const attemptCount = metadataInteger(
    credential.metadata.token_refresh_attempt_count,
  );
  const exhausted = credential.metadata.token_refresh_exhausted === true;
  const autoDisabled = credential.metadata.token_refresh_auto_disabled === true;
  const nextAttemptAt = metadataString(
    credential.metadata.token_refresh_next_attempt_at,
  );
  const lastError =
    metadataString(credential.metadata.token_refresh_last_error) ||
    (exhausted ? credential.lastError || "" : "");
  return {
    attemptCount,
    exhausted,
    autoDisabled,
    nextAttemptAt,
    lastError,
    hasNotice: exhausted || attemptCount > 0,
  };
}

function CredentialProxyBadge({
  credential,
  globalSettings,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  globalSettings: GlobalSettingsRecord;
  proxyPool: ProxyPoolRecord[];
}) {
  const proxy = credential.proxy;
  if (proxy?.enabled) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        title={credentialProxyText(credential)}
      >
        已启用 · {proxy.type}
      </Badge>
    );
  }

  if (credential.proxyPoolId) {
    const pooledProxy = proxyPool.find(
      (proxy) => proxy.id === credential.proxyPoolId,
    );
    if (!pooledProxy) {
      return (
        <Badge variant="outline" title="已选择代理池代理，但该代理不存在">
          代理池 · 缺失
        </Badge>
      );
    }
    return (
      <Badge variant="outline" title={proxyPoolRecordText(pooledProxy)}>
        代理池 · {pooledProxy.enabled ? "已启用" : "已停用"} ·{" "}
        {pooledProxy.type}
      </Badge>
    );
  }

  if (credential.useGlobalProxy) {
    const globalProxy = globalSettings.proxy;
    if (!globalProxy) {
      return (
        <Badge
          variant="outline"
          className="border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          title="已开启全局代理回退，但当前未配置全局代理"
        >
          全局代理 · 未配置
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className={
          globalProxy.enabled
            ? "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "border-border bg-muted/60 text-muted-foreground"
        }
        title={`全局代理（${globalProxySourceLabel(globalSettings.proxySource)}）：${globalProxyText(globalSettings)}`}
      >
        全局代理 · {globalProxy.enabled ? "已启用" : "已停用"} ·{" "}
        {globalProxy.type}
      </Badge>
    );
  }

  if (proxy) {
    return (
      <Badge
        variant="outline"
        className="border-border bg-muted/60 text-muted-foreground"
        title={credentialProxyText(credential)}
      >
        已停用 · {proxy.type}
      </Badge>
    );
  }

  return <Badge variant="outline">未配置</Badge>;
}

function CredentialCompactRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="shrink-0">{label}</span>
      <span
        className="min-w-0 truncate text-right font-medium text-foreground"
        title={typeof value === "string" ? value : undefined}
      >
        {value || "-"}
      </span>
    </div>
  );
}

function CredentialDeleteSettingsAction({
  credential,
  disabled,
  onConfirm,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // Parent action already shows the concrete error toast.
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="justify-start"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" />
        删除凭据
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除 Codex 凭据？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {credential.email || credential.accountId || credential.id}
            。此操作不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function UsageHealthBadge({
  status,
}: {
  status: CodexCredentialRecord["usageHealth"] extends infer Health
    ? Health extends { status: infer Status }
      ? Status
      : never
    : never;
}) {
  if (status === "normal") {
    return (
      <WorkspaceStatusBadge tone="success">
        正常
      </WorkspaceStatusBadge>
    );
  }
  if (status === "warning") {
    return <WorkspaceStatusBadge tone="warning">警告</WorkspaceStatusBadge>;
  }
  if (status === "error") {
    return <WorkspaceStatusBadge tone="danger">错误</WorkspaceStatusBadge>;
  }
  return <WorkspaceStatusBadge tone="muted">未使用</WorkspaceStatusBadge>;
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

function proxyPoolRecordText(proxy: ProxyPoolRecord) {
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function proxyPoolSelectionText(
  credential: CodexCredentialRecord,
  proxyPool: ProxyPoolRecord[],
) {
  if (!credential.proxyPoolId) {
    return "未选择";
  }
  const proxy = proxyPool.find((item) => item.id === credential.proxyPoolId);
  return proxy ? proxyPoolRecordText(proxy) : "代理不存在";
}

function credentialProxyForm(
  credential: CodexCredentialRecord,
): CredentialProxyFormState {
  const proxy = credential.proxy;
  return {
    enabled: proxy?.enabled ?? true,
    type: proxy?.type ?? "socks5h",
    host: proxy?.host ?? "",
    port: proxy?.port ? String(proxy.port) : "1080",
    username: proxy?.username ?? "",
    password: "",
  };
}

function credentialProxyText(credential: CodexCredentialRecord) {
  const proxy = credential.proxy;
  if (!proxy) {
    return "未配置";
  }
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function credentialUpstreamTransportText(transport: CodexUpstreamTransport) {
  return transport === "websocket" ? "WebSocket" : "HTTP";
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败，请手动复制");
  }
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

function metadataString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function metadataInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function integerValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function credentialUploadPayloads(parsed: unknown) {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) {
    return [];
  }
  if (Array.isArray(parsed.credentials)) {
    return parsed.credentials.filter(isRecord);
  }
  if (Array.isArray(parsed.accounts)) {
    return parsed.accounts.filter(isRecord);
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data.filter(isRecord);
  }
  return [parsed];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function codexPlanLabel(planType: string) {
  const normalized = codexPlanKey(planType);
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro 20x",
    prolite: "Pro 5x",
    "pro-lite": "Pro 5x",
    pro_lite: "Pro 5x",
    team: "Team",
  };
  return labels[normalized] || planType || "未知";
}

function usageHealthScore(health: CodexCredentialRecord["usageHealth"]) {
  return clamp(health?.score ?? 100, 0, 100);
}

function isFastCredentialPlan(planType: string) {
  const normalized = planType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return (
    normalized === "pro" || normalized === "pro20" || normalized === "pro20x"
  );
}

function codexPlanRank(planType: string) {
  const normalized = codexPlanKey(planType);
  if (normalized === "pro") {
    return 50;
  }
  if (
    normalized === "prolite" ||
    normalized === "pro-lite" ||
    normalized === "pro_lite"
  ) {
    return 40;
  }
  if (normalized === "team") {
    return 30;
  }
  if (normalized === "plus") {
    return 20;
  }
  if (normalized === "free") {
    return 10;
  }
  return 0;
}

function codexPlanBadgeTone(planType: string) {
  const normalized = codexPlanKey(planType);
  if (
    normalized === "pro" ||
    normalized === "prolite" ||
    normalized === "pro-lite" ||
    normalized === "pro_lite"
  ) {
    return "border-amber-400/70 bg-amber-300/25 text-amber-700 shadow-sm dark:border-amber-300/60 dark:bg-amber-300/20 dark:text-amber-200";
  }
  if (normalized === "team") {
    return "border-violet-500/45 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  }
  if (normalized === "plus") {
    return "border-primary/45 bg-primary/10 text-primary";
  }
  if (normalized === "free") {
    return "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  return "border-border bg-muted/60 text-foreground";
}

function codexPlanKey(planType: string) {
  return planType.trim().toLowerCase();
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

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

