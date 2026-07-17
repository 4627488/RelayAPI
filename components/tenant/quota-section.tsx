"use client";

import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTenantCostAnalysis, getTenantQuota, getTenantSubscriptionResetEvents, tenantErrorMessage, type TenantQuotaReport } from "@/lib/tenant-api";
import type { CostAnalysis } from "@/lib/admin-api";
import { QuotaResetHistorySheet } from "@/components/quota-reset-history-sheet";

export function TenantQuotaSection() {
  const [quota, setQuota] = React.useState<TenantQuotaReport | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [costResult, setCostResult] = React.useState<{ subscriptionId: string; data: CostAnalysis } | null>(null);
  React.useEffect(() => { getTenantQuota().then((next) => { setQuota(next); setSelectedId((current) => current && next.subscriptions.some((item) => item.id === current) ? current : next.subscriptions[0]?.id || null); }).catch((error) => toast.error(tenantErrorMessage(error))); }, []);
  React.useEffect(() => { if (!selectedId) return; const subscriptionId = selectedId; getTenantCostAnalysis(subscriptionId).then((data) => setCostResult({ subscriptionId, data })).catch((error) => toast.error(tenantErrorMessage(error))); }, [selectedId]);
  const selected = quota?.subscriptions.find((item) => item.id === selectedId) || null;
  const costs = costResult?.subscriptionId === selectedId ? costResult.data : null;
  if (quota && quota.subscriptions.length === 0) return <Card><CardContent><Empty><EmptyHeader><EmptyTitle>尚未分配子订阅</EmptyTitle><EmptyDescription>请联系管理员下发订阅份额。</EmptyDescription></EmptyHeader></Empty></CardContent></Card>;
  return <div className="grid gap-4 lg:grid-cols-3">
    <Card><CardHeader><CardTitle>我的子订阅</CardTitle><CardDescription>选择一个子订阅查看其当前 7 天周期。</CardDescription></CardHeader><CardContent className="flex flex-col gap-2">{quota?.subscriptions.map((subscription) => <SubscriptionSelector key={subscription.id} subscription={subscription} active={subscription.id === selectedId} onClick={() => setSelectedId(subscription.id)} />)}</CardContent></Card>
    {selected ? <Card className="lg:col-span-2"><CardHeader><CardTitle>{selected.name}</CardTitle><CardDescription>仅展示此子订阅在当前 7d 重置周期内产生的请求与成本。</CardDescription><CardAction><QuotaResetHistorySheet triggerLabel="重置记录" description={selected.name} load={() => getTenantSubscriptionResetEvents(selected.id).then((result) => result.events)} /></CardAction></CardHeader><CardContent className="flex flex-col gap-6"><div className="grid gap-5 md:grid-cols-2">{(["5h", "7d"] as const).map((kind) => <QuotaLine key={kind} kind={kind} window={selected.windows[kind]} />)}</div><div className="min-w-0"><div className="mb-3"><h3 className="font-medium">模型成本剖析</h3><p className="text-sm text-muted-foreground">累计成本 {formatUsd(costs?.totalCostNanoUsd)}，共 {costs?.pricedRequests ?? 0} 个已定价请求。</p></div><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>当前价格 / 1M Token</TableHead><TableHead>请求</TableHead><TableHead>输入</TableHead><TableHead>输出</TableHead><TableHead>缓存</TableHead><TableHead className="text-right">成本</TableHead></TableRow></TableHeader><TableBody>{costs?.models.map((row) => <TableRow key={row.model}><TableCell>{row.model}</TableCell><TableCell><ModelPrice value={row.pricing} /></TableCell><TableCell>{row.requestCount}</TableCell><TableCell>{row.promptTokens.toLocaleString()}</TableCell><TableCell>{row.completionTokens.toLocaleString()}</TableCell><TableCell>{row.cachedTokens.toLocaleString()}</TableCell><TableCell className="text-right">{formatUsd(row.costNanoUsd)}</TableCell></TableRow>)}</TableBody></Table></div></CardContent></Card> : null}
  </div>;
}
function SubscriptionSelector({ subscription, active, onClick }: { subscription: TenantQuotaReport["subscriptions"][number]; active: boolean; onClick: () => void }) { const weekly = subscription.windows["7d"]; const used = Number(weekly?.settledNanoUsd || 0) + Number(weekly?.reservedNanoUsd || 0); const limit = Number(weekly?.limitNanoUsd || 0); const percent = limit > 0 ? Math.min(100, used / limit * 100) : 0; return <Button type="button" variant={active ? "secondary" : "outline"} className="h-auto w-full justify-start p-3" onClick={onClick}><div className="flex min-w-0 flex-1 flex-col gap-3 text-left"><div className="flex items-start justify-between gap-2"><span className="truncate font-medium">{subscription.name}</span><Badge variant="outline">{subscription.units} 份</Badge></div><Progress value={percent} className="gap-1.5"><ProgressLabel className="text-xs text-muted-foreground">7 天用量</ProgressLabel><ProgressValue className="text-xs font-medium text-foreground">{() => `${Math.round(percent)}%`}</ProgressValue></Progress><span className="truncate text-xs text-muted-foreground">{weekly ? `${new Date(weekly.resetsAt).toLocaleString("zh-CN")} 重置` : "等待首次使用"}</span></div></Button>; }
function QuotaLine({ kind, window }: { kind: "5h" | "7d"; window?: TenantQuotaReport["subscriptions"][number]["windows"]["5h"] }) {
  const limit = Number(window?.limitNanoUsd || 0);
  const settled = Number(window?.settledNanoUsd || 0);
  const reserved = Number(window?.reservedNanoUsd || 0);
  const used = settled + reserved;
  const percent = limit > 0 ? Math.min(100, used / limit * 100) : 0;
  return <div className="flex flex-col gap-3">
    <div className="flex items-end justify-between gap-3"><div><div className="text-xs text-muted-foreground">{kind === "5h" ? "5 小时窗口" : "7 天窗口"}</div><div className="mt-0.5 text-xl font-semibold tracking-tight">{window ? formatUsd(String(used)) : "--"}<span className="ml-1 text-xs font-normal text-muted-foreground">已用</span></div></div><Badge variant="outline">已用 {Math.round(percent)}%</Badge></div>
    <Progress value={percent} className="**:data-[slot=progress-track]:h-2.5" aria-label={`${kind} 额度已使用 ${Math.round(percent)}%`} />
    <div className="grid grid-cols-3 gap-2 text-xs"><QuotaMetric label="已结算" value={formatUsd(String(settled))} /><QuotaMetric label="预留中" value={formatUsd(String(reserved))} /><QuotaMetric label="总额度" value={formatUsd(String(limit))} /></div>
    <span className="text-xs text-muted-foreground">{window ? `重置 ${new Date(window.resetsAt).toLocaleString("zh-CN")} · 已使用 ${Math.round(percent)}%` : "等待首次使用或上游额度刷新"}</span>
  </div>;
}
function QuotaMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-muted/40 p-2"><div className="text-muted-foreground">{label}</div><div className="mt-0.5 truncate font-mono font-medium">{value}</div></div>; }
function formatUsd(value?: string | null) { return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`; }
function ModelPrice({ value }: { value: CostAnalysis["models"][number]["pricing"] }) { return value ? <div className="flex flex-col gap-1 font-mono text-xs"><span>输入 {formatUnitPrice(value.inputNanoUsdPerToken)} · 输出 {formatUnitPrice(value.outputNanoUsdPerToken)}</span><span className="text-muted-foreground">缓存读 {formatUnitPrice(value.cachedInputNanoUsdPerToken)} · 写 {formatUnitPrice(value.cacheWriteNanoUsdPerToken)} · 推理 {formatUnitPrice(value.reasoningNanoUsdPerToken)}</span></div> : <span className="text-muted-foreground">当前目录未定价</span>; }
function formatUnitPrice(value: string) { return `$${(Number(value) / 1_000).toFixed(4)}`; }
