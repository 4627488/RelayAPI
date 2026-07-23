import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import { formatDateTime } from "@/components/workspace/format";
import { cn } from "@/lib/utils";
import { providerCredentialName } from "@/src/shared/providerCapabilities";
import type { ProviderCredentialRecord } from "@/src/shared/types/entities";

export function ProviderCredentialCard({
  actions,
  credential,
  notice,
  overlay,
  planBadgeClassName,
  planLabel,
  proxy,
  quotaAction,
  quotaContent,
  showLastError = true,
}: {
  actions: ReactNode;
  credential: ProviderCredentialRecord;
  notice?: ReactNode;
  overlay?: ReactNode;
  planBadgeClassName?: string;
  planLabel: string;
  proxy: ReactNode;
  quotaAction?: ReactNode;
  quotaContent: ReactNode;
  showLastError?: boolean;
}) {
  const name = providerCredentialName(credential);
  const health = credential.usageHealth;
  return (
    <Card className="relative shadow-sm">
      <CardHeader>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <Badge variant="outline" className={cn("h-6 shrink-0 px-2 text-sm font-semibold", planBadgeClassName)}>{planLabel}</Badge>
            <div className="min-w-0 flex-1 truncate text-base font-medium" title={name}>{name}</div>
          </div>
          <div className="flex shrink-0 justify-end gap-1.5">{actions}</div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notice}
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-muted-foreground">用量采样：</span>
            <UsageHealthStatus credential={credential} />
            {health && <span className="tabular-nums text-muted-foreground">{Math.round(health.score)}%</span>}
          </div>
          {health && health.status !== "unused" && <div className="text-xs text-muted-foreground">最近 {health.windowSize} 次 · 成功 {health.successCount} · 错误 {health.errorCount}</div>}
          {credential.cooldownUntil && <div className="flex items-center gap-2 text-xs text-muted-foreground"><WorkspaceStatusBadge tone="warning">cooldown</WorkspaceStatusBadge>{formatDateTime(credential.cooldownUntil)}</div>}
          {showLastError && credential.lastError && <div className="text-xs text-destructive">{credential.lastError}</div>}
        </div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">请求代理：</span>{proxy}</div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">过期时间：</span><span className="min-w-0 truncate">{credential.expiresAt ? formatDateTime(credential.expiresAt) : "-"}</span></div>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">剩余额度：</span>{quotaAction}</div>
          <div className="rounded-lg border border-border/60 bg-muted/35 p-3">{quotaContent}</div>
        </div>
      </CardContent>
      {overlay}
    </Card>
  );
}

function UsageHealthStatus({ credential }: { credential: ProviderCredentialRecord }) {
  const health = credential.usageHealth;
  if (!health) return <WorkspaceStatusBadge tone="muted">unknown</WorkspaceStatusBadge>;
  if (health.status === "unused") return <WorkspaceStatusBadge tone="muted">未使用</WorkspaceStatusBadge>;
  if (health.status === "error") return <WorkspaceStatusBadge tone="danger">异常</WorkspaceStatusBadge>;
  if (health.status === "warning") return <WorkspaceStatusBadge tone="warning">波动</WorkspaceStatusBadge>;
  return <WorkspaceStatusBadge tone="success">已采样</WorkspaceStatusBadge>;
}
