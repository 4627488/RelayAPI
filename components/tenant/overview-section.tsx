"use client";

import { GaugeIcon, KeyRoundIcon, NetworkIcon, ShieldCheckIcon } from "lucide-react";

import { LimitLine } from "@/components/dashboard/limit-line";
import { DashboardMetricCard } from "@/components/dashboard/metric-card";
import {
  formatNumber,
  formatRatioPercent,
  formatTokenNumber,
} from "@/components/dashboard/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  AdminOverviewStats,
  PublicTenant,
} from "@/src/shared/types/entities";

export function TenantOverviewSection({
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
        <DashboardMetricCard
          title="请求"
          value={formatNumber(totals.requestCount)}
          description="当前租户累计转发请求"
          icon={GaugeIcon}
        />
        <DashboardMetricCard
          title="成功率"
          value={formatRatioPercent(totals.successCount, totals.requestCount)}
          description="按最近日志聚合计算"
          icon={ShieldCheckIcon}
        />
        <DashboardMetricCard
          title="Token"
          value={formatTokenNumber(totals.totalTokens)}
          description="Prompt 与 completion 合计"
          icon={NetworkIcon}
        />
        <DashboardMetricCard
          title="活跃 Key"
          value={formatNumber(totals.distinctApiKeyCount)}
          description="产生过请求的密钥数量"
          icon={KeyRoundIcon}
        />
      </div>
      <Card className="bg-card/95">
        <CardHeader>
          <CardTitle>租户总池</CardTitle>
          <CardDescription>所有 Key 合计不能超过管理员配置的限制。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <LimitLine
            label="Key 数"
            value={tenant.apiKeyCount}
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
        </CardContent>
      </Card>
    </div>
  );
}
