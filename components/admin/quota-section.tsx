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
  const [fiveHourOversell, setFiveHourOversell] = React.useState("1");
  const [weeklyOversell, setWeeklyOversell] = React.useState("1");
  const [priceModel, setPriceModel] = React.useState("");
  const [inputPrice, setInputPrice] = React.useState("");
  const [outputPrice, setOutputPrice] = React.useState("");
  const [cachedInputPrice, setCachedInputPrice] = React.useState("");
  const [cacheWritePrice, setCacheWritePrice] = React.useState("");
  const [reasoningPrice, setReasoningPrice] = React.useState("");
  const [savingPrice, setSavingPrice] = React.useState(false);
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
      setFiveHourOversell(String(nextQuota.baselines["5h"].oversellRatio));
      setWeeklyOversell(String(nextQuota.baselines["7d"].oversellRatio));
      setPriceModel((current) => current || nextQuota.pricing.pendingModels[0]?.model || "");
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

  React.useEffect(() => {
    const status = quota?.pricing.backfill.status;
    if (status !== "pending" && status !== "running") return;
    const timer = window.setTimeout(() => void load(), 1_000);
    return () => window.clearTimeout(timer);
  }, [load, quota?.pricing.backfill.status]);

  async function saveBaselines() {
    try {
      setQuota(await updateQuotaAdministration({
        baselines: { "5h": usdToNanoUsd(fiveHour), "7d": usdToNanoUsd(weekly) },
        oversellRatios: { "5h": positiveDecimal(fiveHourOversell), "7d": positiveDecimal(weeklyOversell) },
      }));
      toast.success("份额额度基线与超卖比例已保存");
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

  async function saveModelPrice() {
    const model = priceModel.trim();
    if (!model || !positiveUnitPrice(inputPrice) || !positiveUnitPrice(outputPrice)) {
      toast.error("请填写模型名称以及有效的输入、输出价格");
      return;
    }
    setSavingPrice(true);
    try {
      const overrides = Object.fromEntries(
        (quota?.pricing.overrides || []).map((row) => [row.model, row]),
      );
      overrides[model] = {
        inputNanoUsdPerToken: unitPriceToNanoUsd(inputPrice),
        outputNanoUsdPerToken: unitPriceToNanoUsd(outputPrice),
        ...(cachedInputPrice.trim() ? { cachedInputNanoUsdPerToken: unitPriceToNanoUsd(cachedInputPrice) } : {}),
        ...(cacheWritePrice.trim() ? { cacheWriteNanoUsdPerToken: unitPriceToNanoUsd(cacheWritePrice) } : {}),
        ...(reasoningPrice.trim() ? { reasoningNanoUsdPerToken: unitPriceToNanoUsd(reasoningPrice) } : {}),
      };
      setQuota(await updateQuotaAdministration({ overrides }));
      toast.success("模型价格已保存，待定价记录正在后台核算");
      window.setTimeout(() => void load(), 500);
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setSavingPrice(false); }
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
            <CardDescription>Plus 为 1 份，Pro 为 20 份；基线留空即使用自动校准结果。超卖比例 1 表示不超卖，2 表示发放两倍额度。</CardDescription>
            <CardAction><Button size="sm" onClick={saveBaselines}><SaveIcon data-icon="inline-start" />保存</Button></CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field><FieldLabel htmlFor="quota-5h">每份 5 小时额度（USD）</FieldLabel><Input id="quota-5h" inputMode="decimal" value={fiveHour} placeholder={nanoUsdToUsd(quota?.baselines["5h"].automaticNanoUsd)} onChange={(event) => setFiveHour(event.target.value)} /><FieldDescription>置信度 {formatPercent(quota?.baselines["5h"].confidence)} · {quota?.baselines["5h"].sampleCount ?? 0} 个有效样本</FieldDescription></Field>
              <Field><FieldLabel htmlFor="quota-5h-oversell">5 小时超卖比例</FieldLabel><Input id="quota-5h-oversell" inputMode="decimal" value={fiveHourOversell} onChange={(event) => setFiveHourOversell(event.target.value)} /><FieldDescription>当前向用户发放基线容量的 {fiveHourOversell || "-"} 倍。</FieldDescription></Field>
              <Field><FieldLabel htmlFor="quota-7d">每份 7 天额度（USD）</FieldLabel><Input id="quota-7d" inputMode="decimal" value={weekly} placeholder={nanoUsdToUsd(quota?.baselines["7d"].automaticNanoUsd)} onChange={(event) => setWeekly(event.target.value)} /><FieldDescription>置信度 {formatPercent(quota?.baselines["7d"].confidence)} · {quota?.baselines["7d"].sampleCount ?? 0} 个有效样本</FieldDescription></Field>
              <Field><FieldLabel htmlFor="quota-7d-oversell">7 天超卖比例</FieldLabel><Input id="quota-7d-oversell" inputMode="decimal" value={weeklyOversell} onChange={(event) => setWeeklyOversell(event.target.value)} /><FieldDescription>当前向用户发放基线容量的 {weeklyOversell || "-"} 倍。</FieldDescription></Field>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>模型定价目录</CardTitle><CardDescription>请求使用发生时的价格版本，历史成本不会被重算。</CardDescription><CardAction><Button variant="outline" size="sm" disabled={loading} onClick={refreshCatalog}>{loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}同步 LiteLLM</Button></CardAction></CardHeader>
          <CardContent className="flex flex-col gap-2"><div className="flex items-center justify-between"><span>已定价模型</span><Badge variant="secondary">{quota?.pricing.catalogModelCount ?? 0}</Badge></div><div className="flex items-center justify-between"><span>目录版本</span><span className="max-w-72 truncate text-muted-foreground">{quota?.pricing.catalogVersion || "内置快照"}</span></div><div className="flex items-center justify-between"><span>更新时间</span><span className="text-muted-foreground">{formatDate(quota?.pricing.catalogUpdatedAt)}</span></div></CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>待定价模型</CardTitle>
          <CardDescription>未配置价格的请求会先放行并记录。此处价格单位为 USD / 1M Token；保存后后台仅补算尚未定价的历史记录。</CardDescription>
          <CardAction><Badge variant="secondary">{quota?.pricing.pendingModels.reduce((sum, item) => sum + item.requestCount, 0) ?? 0} 条待核算</Badge></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup>
            <Field><FieldLabel htmlFor="pricing-model">模型名称</FieldLabel><Input id="pricing-model" value={priceModel} placeholder="例如 custom-model-v1" onChange={(event) => setPriceModel(event.target.value)} /><FieldDescription>必须与请求日志中的模型名称完全一致。</FieldDescription></Field>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Field><FieldLabel htmlFor="pricing-input">输入</FieldLabel><Input id="pricing-input" inputMode="decimal" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="pricing-output">输出</FieldLabel><Input id="pricing-output" inputMode="decimal" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="pricing-cache-read">缓存读（可选）</FieldLabel><Input id="pricing-cache-read" inputMode="decimal" value={cachedInputPrice} onChange={(event) => setCachedInputPrice(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="pricing-cache-write">缓存写（可选）</FieldLabel><Input id="pricing-cache-write" inputMode="decimal" value={cacheWritePrice} onChange={(event) => setCacheWritePrice(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="pricing-reasoning">推理（可选）</FieldLabel><Input id="pricing-reasoning" inputMode="decimal" value={reasoningPrice} onChange={(event) => setReasoningPrice(event.target.value)} /></Field>
            </div>
          </FieldGroup>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">后台任务：{backfillLabel(quota?.pricing.backfill)}</span>
            <Button onClick={saveModelPrice} disabled={savingPrice}>{savingPrice ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}保存价格并核算</Button>
          </div>
          {(quota?.pricing.pendingModels.length ?? 0) > 0 && <Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>待核算请求</TableHead><TableHead>最近请求</TableHead></TableRow></TableHeader><TableBody>{quota?.pricing.pendingModels.map((item) => <TableRow key={item.model} onClick={() => setPriceModel(item.model)} className="cursor-pointer"><TableCell>{item.model}</TableCell><TableCell>{item.requestCount}</TableCell><TableCell>{formatDate(item.latestStartedAt)}</TableCell></TableRow>)}</TableBody></Table>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>模型成本剖析</CardTitle><CardDescription>逐模型展示当前生效价格与累计用量；历史成本仍按请求发生时的价格快照计算。累计成本 {formatUsd(costs?.totalCostNanoUsd)}，共 {costs?.pricedRequests ?? 0} 个已定价请求。</CardDescription></CardHeader>
        <CardContent><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>当前价格 / 1M Token</TableHead><TableHead>请求</TableHead><TableHead>输入</TableHead><TableHead>输出</TableHead><TableHead>缓存</TableHead><TableHead className="text-right">换算成本</TableHead></TableRow></TableHeader><TableBody>{costs?.models.map((row) => <TableRow key={row.model}><TableCell>{row.model}</TableCell><TableCell><ModelPrice value={row.pricing} /></TableCell><TableCell>{row.requestCount}</TableCell><TableCell>{row.promptTokens.toLocaleString()}</TableCell><TableCell>{row.completionTokens.toLocaleString()}</TableCell><TableCell>{row.cachedTokens.toLocaleString()}</TableCell><TableCell className="text-right">{formatUsd(row.costNanoUsd)}</TableCell></TableRow>)}</TableBody></Table></CardContent>
      </Card>
    </div>
  );
}

function usdToNanoUsd(value: string) { const clean = value.trim(); return clean ? String(Math.round(Number(clean) * 1_000_000_000)) : null; }
function positiveDecimal(value: string) { const parsed = Number(value.trim()); return Number.isFinite(parsed) && parsed > 0 ? parsed : 1; }
function nanoUsdToUsd(value?: string | null) { return value ? (Number(value) / 1_000_000_000).toFixed(4) : ""; }
function formatUsd(value?: string | null) { return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`; }
function formatPercent(value?: number) { return `${Math.round((value || 0) * 100)}%`; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "尚未同步"; }
function ModelPrice({ value }: { value: CostAnalysis["models"][number]["pricing"] }) { return value ? <div className="flex flex-col gap-1 font-mono text-xs"><span>输入 {formatUnitPrice(value.inputNanoUsdPerToken)} · 输出 {formatUnitPrice(value.outputNanoUsdPerToken)}</span><span className="text-muted-foreground">缓存读 {formatUnitPrice(value.cachedInputNanoUsdPerToken)} · 写 {formatUnitPrice(value.cacheWriteNanoUsdPerToken)} · 推理 {formatUnitPrice(value.reasoningNanoUsdPerToken)}</span></div> : <span className="text-muted-foreground">当前目录未定价</span>; }
function formatUnitPrice(value: string) { return `$${(Number(value) / 1_000).toFixed(4)}`; }
function positiveUnitPrice(value: string) { const parsed = Number(value.trim()); return Number.isFinite(parsed) && Math.round(parsed * 1_000) > 0; }
function unitPriceToNanoUsd(value: string) { return String(Math.round(Number(value.trim()) * 1_000)); }
function backfillLabel(value?: QuotaAdministration["pricing"]["backfill"]) {
  if (!value || value.status === "idle") return "尚未运行";
  if (value.status === "pending") return "等待执行";
  if (value.status === "running") return "核算中";
  if (value.status === "failed") return `失败：${value.error || "未知错误"}`;
  return `已完成，补算 ${value.updatedRequests} 条`;
}
