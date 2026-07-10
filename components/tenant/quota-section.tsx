"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTenantCostAnalysis, getTenantQuota, tenantErrorMessage, type TenantQuotaReport } from "@/lib/tenant-api";
import type { CostAnalysis } from "@/lib/admin-api";

export function TenantQuotaSection() {
  const [quota, setQuota] = React.useState<TenantQuotaReport | null>(null);
  const [costs, setCosts] = React.useState<CostAnalysis | null>(null);
  React.useEffect(() => { Promise.all([getTenantQuota(), getTenantCostAnalysis()]).then(([nextQuota, nextCosts]) => { setQuota(nextQuota); setCosts(nextCosts); }).catch((error) => toast.error(tenantErrorMessage(error))); }, []);
  return <div className="flex flex-col gap-3">
    <div className="grid gap-3 md:grid-cols-2">{(["5h", "7d"] as const).map((kind) => <QuotaCard key={kind} kind={kind} window={quota?.windows[kind]} shares={quota?.shares} />)}</div>
    <Card><CardHeader><CardTitle>模型成本剖析</CardTitle><CardDescription>逐模型展示当前生效价格与本租户累计用量；历史成本仍按请求发生时的价格快照计算。累计成本 {formatUsd(costs?.totalCostNanoUsd)}。</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>当前价格 / 1M Token</TableHead><TableHead>请求</TableHead><TableHead>输入</TableHead><TableHead>输出</TableHead><TableHead>缓存</TableHead><TableHead className="text-right">成本</TableHead></TableRow></TableHeader><TableBody>{costs?.models.map((row) => <TableRow key={row.model}><TableCell>{row.model}</TableCell><TableCell><ModelPrice value={row.pricing} /></TableCell><TableCell>{row.requestCount}</TableCell><TableCell>{row.promptTokens.toLocaleString()}</TableCell><TableCell>{row.completionTokens.toLocaleString()}</TableCell><TableCell>{row.cachedTokens.toLocaleString()}</TableCell><TableCell className="text-right">{formatUsd(row.costNanoUsd)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
  </div>;
}

function QuotaCard({ kind, window, shares }: { kind: "5h" | "7d"; window?: TenantQuotaReport["windows"]["5h"]; shares?: number | null }) {
  const limit = Number(window?.limitNanoUsd || 0); const used = Number(window?.settledNanoUsd || 0) + Number(window?.reservedNanoUsd || 0); const percent = limit > 0 ? Math.min(100, used / limit * 100) : 0;
  return <Card><CardHeader><CardTitle>{kind === "5h" ? "5 小时额度" : "7 天额度"}</CardTitle><CardDescription>{shares ? `${shares} 份租户额度` : "未启用份额限制"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><div className="flex items-center justify-between"><span>{formatUsd(String(used))} / {formatUsd(String(limit))}</span><Badge variant="outline">{Math.round(percent)}%</Badge></div><Progress value={percent} /><span className="text-muted-foreground">重置时间 {window ? new Date(window.resetsAt).toLocaleString("zh-CN") : "尚未开启窗口"}</span></CardContent></Card>;
}

function formatUsd(value?: string | null) { return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`; }
function ModelPrice({ value }: { value: CostAnalysis["models"][number]["pricing"] }) { return value ? <div className="flex flex-col gap-1 font-mono text-xs"><span>输入 {formatUnitPrice(value.inputNanoUsdPerToken)} · 输出 {formatUnitPrice(value.outputNanoUsdPerToken)}</span><span className="text-muted-foreground">缓存读 {formatUnitPrice(value.cachedInputNanoUsdPerToken)} · 写 {formatUnitPrice(value.cacheWriteNanoUsdPerToken)} · 推理 {formatUnitPrice(value.reasoningNanoUsdPerToken)}</span></div> : <span className="text-muted-foreground">当前目录未定价</span>; }
function formatUnitPrice(value: string) { return `$${(Number(value) / 1_000).toFixed(4)}`; }
