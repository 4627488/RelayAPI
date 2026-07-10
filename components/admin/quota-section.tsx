"use client";

import * as React from "react";
import { RefreshCwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  adminErrorMessage,
  getAdminCostAnalysis,
  getQuotaAdministration,
  refreshQuotaPricing,
  updateQuotaAdministration,
  type CostAnalysis,
  type QuotaAdministration,
} from "@/lib/admin-api";

export function AdminQuotaSection() {
  const [quota, setQuota] = React.useState<QuotaAdministration | null>(null);
  const [costs, setCosts] = React.useState<CostAnalysis | null>(null);
  const [fiveHour, setFiveHour] = React.useState("");
  const [weekly, setWeekly] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextQuota, nextCosts] = await Promise.all([
        getQuotaAdministration(),
        getAdminCostAnalysis(),
      ]);
      setQuota(nextQuota);
      setCosts(nextCosts);
      setFiveHour(nanoUsdToUsd(nextQuota.baselines["5h"].overrideNanoUsd));
      setWeekly(nanoUsdToUsd(nextQuota.baselines["7d"].overrideNanoUsd));
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function saveBaselines() {
    try {
      setQuota(await updateQuotaAdministration({
        baselines: { "5h": usdToNanoUsd(fiveHour), "7d": usdToNanoUsd(weekly) },
      }));
      toast.success("份额额度覆盖已保存");
    } catch (error) { toast.error(adminErrorMessage(error)); }
  }

  async function refreshCatalog() {
    setLoading(true);
    try {
      setQuota(await refreshQuotaPricing());
      toast.success("LiteLLM 定价目录已更新");
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setLoading(false); }
  }

  return (
    <div className="flex flex-col gap-3">
      {quota?.pricing.catalogError && (
        <Alert variant="destructive"><AlertTitle>定价目录同步失败</AlertTitle><AlertDescription>{quota.pricing.catalogError}</AlertDescription></Alert>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>份额额度基线</CardTitle>
            <CardDescription>Plus 为 1 份，Pro 为 20 份；留空即使用自动校准结果。</CardDescription>
            <CardAction><Button size="sm" onClick={saveBaselines}><SaveIcon data-icon="inline-start" />保存</Button></CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field><FieldLabel htmlFor="quota-5h">每份 5 小时额度（USD）</FieldLabel><Input id="quota-5h" inputMode="decimal" value={fiveHour} placeholder={nanoUsdToUsd(quota?.baselines["5h"].automaticNanoUsd)} onChange={(event) => setFiveHour(event.target.value)} /><FieldDescription>置信度 {formatPercent(quota?.baselines["5h"].confidence)} · {quota?.baselines["5h"].sampleCount ?? 0} 个有效样本</FieldDescription></Field>
              <Field><FieldLabel htmlFor="quota-7d">每份 7 天额度（USD）</FieldLabel><Input id="quota-7d" inputMode="decimal" value={weekly} placeholder={nanoUsdToUsd(quota?.baselines["7d"].automaticNanoUsd)} onChange={(event) => setWeekly(event.target.value)} /><FieldDescription>置信度 {formatPercent(quota?.baselines["7d"].confidence)} · {quota?.baselines["7d"].sampleCount ?? 0} 个有效样本</FieldDescription></Field>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>模型定价目录</CardTitle><CardDescription>请求使用发生时的价格版本，历史成本不会被重算。</CardDescription><CardAction><Button variant="outline" size="sm" disabled={loading} onClick={refreshCatalog}>{loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}同步 LiteLLM</Button></CardAction></CardHeader>
          <CardContent className="flex flex-col gap-2"><div className="flex items-center justify-between"><span>已定价模型</span><Badge variant="secondary">{quota?.pricing.catalogModelCount ?? 0}</Badge></div><div className="flex items-center justify-between"><span>目录版本</span><span className="max-w-72 truncate text-muted-foreground">{quota?.pricing.catalogVersion || "内置快照"}</span></div><div className="flex items-center justify-between"><span>更新时间</span><span className="text-muted-foreground">{formatDate(quota?.pricing.catalogUpdatedAt)}</span></div></CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>模型成本剖析</CardTitle><CardDescription>累计价格加权成本 {formatUsd(costs?.totalCostNanoUsd)}，共 {costs?.pricedRequests ?? 0} 个已定价请求。</CardDescription></CardHeader>
        <CardContent><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>请求</TableHead><TableHead>输入</TableHead><TableHead>输出</TableHead><TableHead>缓存</TableHead><TableHead className="text-right">换算成本</TableHead></TableRow></TableHeader><TableBody>{costs?.models.map((row) => <TableRow key={row.model}><TableCell>{row.model}</TableCell><TableCell>{row.requestCount}</TableCell><TableCell>{row.promptTokens.toLocaleString()}</TableCell><TableCell>{row.completionTokens.toLocaleString()}</TableCell><TableCell>{row.cachedTokens.toLocaleString()}</TableCell><TableCell className="text-right">{formatUsd(row.costNanoUsd)}</TableCell></TableRow>)}</TableBody></Table></CardContent>
      </Card>
    </div>
  );
}

function usdToNanoUsd(value: string) { const clean = value.trim(); return clean ? String(Math.round(Number(clean) * 1_000_000_000)) : null; }
function nanoUsdToUsd(value?: string | null) { return value ? (Number(value) / 1_000_000_000).toFixed(4) : ""; }
function formatUsd(value?: string | null) { return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`; }
function formatPercent(value?: number) { return `${Math.round((value || 0) * 100)}%`; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "尚未同步"; }
