"use client";

import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTenantCostAnalysis, getTenantQuota, tenantErrorMessage, type TenantQuotaReport } from "@/lib/tenant-api";
import type { CostAnalysis } from "@/lib/admin-api";

export function TenantQuotaSection() {
  const [quota, setQuota] = React.useState<TenantQuotaReport | null>(null);
  const [costs, setCosts] = React.useState<CostAnalysis | null>(null);
  React.useEffect(() => { Promise.all([getTenantQuota(), getTenantCostAnalysis()]).then(([nextQuota, nextCosts]) => { setQuota(nextQuota); setCosts(nextCosts); }).catch((error) => toast.error(tenantErrorMessage(error))); }, []);
  return <div className="flex flex-col gap-3">
    <Card><CardHeader><CardTitle>我的子订阅</CardTitle><CardDescription>每份额度独立结算，并严格继承实际承载订阅的重置时间。</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
      {quota?.subscriptions.length ? quota.subscriptions.map((subscription) => <SubscriptionCard key={subscription.id} subscription={subscription} />) : <Empty className="col-span-full"><EmptyHeader><EmptyTitle>尚未分配子订阅</EmptyTitle><EmptyDescription>请联系管理员下发订阅份额。</EmptyDescription></EmptyHeader></Empty>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>模型成本剖析</CardTitle><CardDescription>模型价格用于推测请求占完整订阅容量的比例；历史请求按发生时的价格快照计算。累计成本 {formatUsd(costs?.totalCostNanoUsd)}。</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>当前价格 / 1M Token</TableHead><TableHead>请求</TableHead><TableHead>输入</TableHead><TableHead>输出</TableHead><TableHead>缓存</TableHead><TableHead className="text-right">成本</TableHead></TableRow></TableHeader><TableBody>{costs?.models.map((row) => <TableRow key={row.model}><TableCell>{row.model}</TableCell><TableCell><ModelPrice value={row.pricing} /></TableCell><TableCell>{row.requestCount}</TableCell><TableCell>{row.promptTokens.toLocaleString()}</TableCell><TableCell>{row.completionTokens.toLocaleString()}</TableCell><TableCell>{row.cachedTokens.toLocaleString()}</TableCell><TableCell className="text-right">{formatUsd(row.costNanoUsd)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
  </div>;
}
function SubscriptionCard({ subscription }: { subscription: TenantQuotaReport["subscriptions"][number] }) { return <Card><CardHeader className="border-b"><div className="flex items-center justify-between gap-2"><CardTitle>{subscription.name}</CardTitle><Badge variant="outline">{subscription.units} 份额度</Badge></div><CardDescription>{subscription.expiresAt ? `有效至 ${new Date(subscription.expiresAt).toLocaleString("zh-CN")}` : "长期有效"} · 每凭据 {subscription.unitsPerCredential} 份</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{(["5h", "7d"] as const).map((kind) => <QuotaLine key={kind} kind={kind} window={subscription.windows[kind]} />)}</CardContent></Card>; }
function QuotaLine({ kind, window }: { kind: "5h" | "7d"; window?: TenantQuotaReport["subscriptions"][number]["windows"]["5h"] }) {
  const limit = Number(window?.limitNanoUsd || 0);
  const settled = Number(window?.settledNanoUsd || 0);
  const reserved = Number(window?.reservedNanoUsd || 0);
  const used = settled + reserved;
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, used / limit * 100) : 0;
  return <div className="flex flex-col gap-3">
    <div className="flex items-end justify-between gap-3"><div><div className="text-xs text-muted-foreground">{kind === "5h" ? "5 小时窗口" : "7 天窗口"}</div><div className="mt-0.5 text-xl font-semibold tracking-tight">{window ? formatUsd(String(remaining)) : "--"}<span className="ml-1 text-xs font-normal text-muted-foreground">剩余</span></div></div><Badge variant="outline">剩余 {Math.round(100 - percent)}%</Badge></div>
    <QuotaSegments percent={percent} />
    <div className="grid grid-cols-3 gap-2 text-xs"><QuotaMetric label="已结算" value={formatUsd(String(settled))} /><QuotaMetric label="预留中" value={formatUsd(String(reserved))} /><QuotaMetric label="总额度" value={formatUsd(String(limit))} /></div>
    <span className="text-xs text-muted-foreground">{window ? `重置 ${new Date(window.resetsAt).toLocaleString("zh-CN")} · 已使用 ${Math.round(percent)}%` : "等待首次使用或上游额度刷新"}</span>
  </div>;
}
function QuotaSegments({ percent }: { percent: number }) { const usedSegments = Math.ceil(percent / 5); return <div className="flex h-7 items-end gap-1" aria-label={`额度已使用 ${Math.round(percent)}%`}>{Array.from({ length: 20 }, (_, index) => <span key={index} className={`min-w-0 flex-1 rounded-xs ${index < usedSegments ? "bg-chart-1" : "bg-muted"}`} style={{ height: `${45 + (index % 4) * 15}%` }} />)}</div>; }
function QuotaMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-muted/40 p-2"><div className="text-muted-foreground">{label}</div><div className="mt-0.5 truncate font-mono font-medium">{value}</div></div>; }
function formatUsd(value?: string | null) { return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`; }
function ModelPrice({ value }: { value: CostAnalysis["models"][number]["pricing"] }) { return value ? <div className="flex flex-col gap-1 font-mono text-xs"><span>输入 {formatUnitPrice(value.inputNanoUsdPerToken)} · 输出 {formatUnitPrice(value.outputNanoUsdPerToken)}</span><span className="text-muted-foreground">缓存读 {formatUnitPrice(value.cachedInputNanoUsdPerToken)} · 写 {formatUnitPrice(value.cacheWriteNanoUsdPerToken)} · 推理 {formatUnitPrice(value.reasoningNanoUsdPerToken)}</span></div> : <span className="text-muted-foreground">当前目录未定价</span>; }
function formatUnitPrice(value: string) { return `$${(Number(value) / 1_000).toFixed(4)}`; }
