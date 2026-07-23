"use client";

import * as React from "react";
import {
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminErrorMessage,
  getAdminCostAnalysis,
  getQuotaAdministration,
  refreshQuotaPricing,
  updateQuotaAdministration,
  type CostAnalysis,
  type ModelPricingOverride,
  type QuotaAdministration,
} from "@/lib/admin-api";

export function AdminQuotaSection() {
  const [quota, setQuota] = React.useState<QuotaAdministration | null>(null);
  const [costs, setCosts] = React.useState<CostAnalysis | null>(null);
  const [priceModel, setPriceModel] = React.useState("");
  const [editingModel, setEditingModel] = React.useState<string | null>(null);
  const [inputPrice, setInputPrice] = React.useState("");
  const [outputPrice, setOutputPrice] = React.useState("");
  const [cachedInputPrice, setCachedInputPrice] = React.useState("");
  const [cacheWritePrice, setCacheWritePrice] = React.useState("");
  const [reasoningPrice, setReasoningPrice] = React.useState("");
  const [savingPrice, setSavingPrice] = React.useState(false);
  const [pendingDelete, setPendingDelete] =
    React.useState<ModelPricingOverride | null>(null);
  const [deletingPrice, setDeletingPrice] = React.useState(false);
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
      setPriceModel(
        (current) => current || nextQuota.pricing.pendingModels[0]?.model || "",
      );
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

  async function refreshCatalog() {
    setLoading(true);
    try {
      setQuota(await refreshQuotaPricing());
      toast.success("LiteLLM 定价目录已更新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function resetPriceForm(model = "") {
    setEditingModel(null);
    setPriceModel(model);
    setInputPrice("");
    setOutputPrice("");
    setCachedInputPrice("");
    setCacheWritePrice("");
    setReasoningPrice("");
  }

  function editModelPrice(price: ModelPricingOverride) {
    setEditingModel(price.model);
    setPriceModel(price.model);
    setInputPrice(nanoUsdPerTokenToUnitPrice(price.inputNanoUsdPerToken));
    setOutputPrice(nanoUsdPerTokenToUnitPrice(price.outputNanoUsdPerToken));
    setCachedInputPrice(
      nanoUsdPerTokenToUnitPrice(price.cachedInputNanoUsdPerToken),
    );
    setCacheWritePrice(
      nanoUsdPerTokenToUnitPrice(price.cacheWriteNanoUsdPerToken),
    );
    setReasoningPrice(
      nanoUsdPerTokenToUnitPrice(price.reasoningNanoUsdPerToken),
    );
    window.requestAnimationFrame(() =>
      document.getElementById("pricing-model")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      }),
    );
  }

  async function saveModelPrice() {
    const model = priceModel.trim();
    if (
      !model ||
      !positiveUnitPrice(inputPrice) ||
      !positiveUnitPrice(outputPrice) ||
      !validOptionalUnitPrice(cachedInputPrice) ||
      !validOptionalUnitPrice(cacheWritePrice) ||
      !validOptionalUnitPrice(reasoningPrice)
    ) {
      toast.error("请填写模型名称以及有效的价格");
      return;
    }
    setSavingPrice(true);
    try {
      const overrides = overridesPayload(quota?.pricing.overrides || []);
      overrides[model] = {
        inputNanoUsdPerToken: unitPriceToNanoUsd(inputPrice),
        outputNanoUsdPerToken: unitPriceToNanoUsd(outputPrice),
        ...(cachedInputPrice.trim()
          ? {
              cachedInputNanoUsdPerToken:
                unitPriceToNanoUsd(cachedInputPrice),
            }
          : {}),
        ...(cacheWritePrice.trim()
          ? {
              cacheWriteNanoUsdPerToken:
                unitPriceToNanoUsd(cacheWritePrice),
            }
          : {}),
        ...(reasoningPrice.trim()
          ? {
              reasoningNanoUsdPerToken: unitPriceToNanoUsd(reasoningPrice),
            }
          : {}),
      };
      setQuota(await updateQuotaAdministration({ overrides }));
      resetPriceForm();
      toast.success(
        editingModel
          ? "自定义价格已更新，待定价记录正在后台核算"
          : "自定义价格已保存，待定价记录正在后台核算",
      );
      window.setTimeout(() => void load(), 500);
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSavingPrice(false);
    }
  }

  async function deleteModelPrice() {
    if (!pendingDelete) return;
    setDeletingPrice(true);
    try {
      const overrides = overridesPayload(
        (quota?.pricing.overrides || []).filter(
          (item) => item.model !== pendingDelete.model,
        ),
      );
      setQuota(await updateQuotaAdministration({ overrides }));
      if (editingModel === pendingDelete.model) resetPriceForm();
      toast.success(`已删除 ${pendingDelete.model} 的自定义价格`);
      setPendingDelete(null);
      window.setTimeout(() => void load(), 500);
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setDeletingPrice(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {quota?.pricing.catalogError && (
        <Alert variant="destructive">
          <AlertTitle>定价目录同步失败</AlertTitle>
          <AlertDescription>{quota.pricing.catalogError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>模型定价目录</CardTitle>
          <CardDescription>
            请求使用发生时的价格版本，历史成本不会被重算。
          </CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={refreshCatalog}
            >
              {loading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              同步 LiteLLM
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span>已定价模型</span>
            <Badge variant="secondary">
              {quota?.pricing.catalogModelCount ?? 0}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span>目录版本</span>
            <span className="max-w-72 truncate text-muted-foreground">
              {quota?.pricing.catalogVersion || "内置快照"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>更新时间</span>
            <span className="text-muted-foreground">
              {formatDate(quota?.pricing.catalogUpdatedAt)}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editingModel ? "编辑自定义价格" : "添加自定义价格"}</CardTitle>
          <CardDescription>
            价格单位为 USD / 1M Token。自定义价格优先于 LiteLLM
            和内置目录；保存后只补算尚未定价的历史记录。
          </CardDescription>
          <CardAction>
            {editingModel ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={savingPrice}
                onClick={() => resetPriceForm()}
              >
                <PlusIcon data-icon="inline-start" />
                新增价格
              </Button>
            ) : (
              <Badge variant="secondary">
                {quota?.pricing.pendingModels.reduce(
                  (sum, item) => sum + item.requestCount,
                  0,
                ) ?? 0}{" "}
                条待核算
              </Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-disabled={Boolean(editingModel) || undefined}>
              <FieldLabel htmlFor="pricing-model">模型名称</FieldLabel>
              <Input
                id="pricing-model"
                value={priceModel}
                placeholder="例如 custom-model-v1"
                disabled={Boolean(editingModel)}
                onChange={(event) => setPriceModel(event.target.value)}
              />
              <FieldDescription>
                {editingModel
                  ? "编辑时模型名称不可修改；如需改名，请删除后重新添加。"
                  : "必须与请求日志中的模型名称完全一致。"}
              </FieldDescription>
            </Field>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <PriceField
                id="pricing-input"
                label="输入"
                value={inputPrice}
                onChange={setInputPrice}
              />
              <PriceField
                id="pricing-output"
                label="输出"
                value={outputPrice}
                onChange={setOutputPrice}
              />
              <PriceField
                id="pricing-cached"
                label="缓存读（可选）"
                value={cachedInputPrice}
                onChange={setCachedInputPrice}
              />
              <PriceField
                id="pricing-cache-write"
                label="缓存写（可选）"
                value={cacheWritePrice}
                onChange={setCacheWritePrice}
              />
              <PriceField
                id="pricing-reasoning"
                label="推理（可选）"
                value={reasoningPrice}
                onChange={setReasoningPrice}
              />
            </div>
          </FieldGroup>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              后台任务：{backfillLabel(quota?.pricing.backfill)}
            </span>
            <Button onClick={saveModelPrice} disabled={savingPrice}>
              {savingPrice ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {editingModel ? "更新价格并核算" : "保存价格并核算"}
            </Button>
          </div>
          {(quota?.pricing.pendingModels.length ?? 0) > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>待定价模型</TableHead>
                  <TableHead>待核算请求</TableHead>
                  <TableHead>最近请求</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quota?.pricing.pendingModels.map((item) => (
                  <TableRow
                    key={item.model}
                    className="cursor-pointer"
                    onClick={() => resetPriceForm(item.model)}
                  >
                    <TableCell>{item.model}</TableCell>
                    <TableCell>{item.requestCount}</TableCell>
                    <TableCell>{formatDate(item.latestStartedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自定义价目表</CardTitle>
          <CardDescription>
            管理所有优先于同步目录生效的模型价格。删除后将恢复使用
            LiteLLM 或内置目录价格；已经写入请求日志的历史价格快照不会改变。
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">
              {quota?.pricing.overrides.length ?? 0} 项
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          {(quota?.pricing.overrides.length ?? 0) === 0 ? (
            <Empty className="min-h-40">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SaveIcon />
                </EmptyMedia>
                <EmptyTitle>尚无自定义价格</EmptyTitle>
                <EmptyDescription>
                  从上方添加模型价格，或点击待定价模型快速填入名称。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>输入</TableHead>
                  <TableHead>输出</TableHead>
                  <TableHead>缓存读</TableHead>
                  <TableHead>缓存写</TableHead>
                  <TableHead>推理</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {quota?.pricing.overrides.map((price) => (
                  <TableRow key={price.model}>
                    <TableCell className="font-medium">
                      {price.model}
                    </TableCell>
                    <TableCell>
                      {formatUnitPrice(price.inputNanoUsdPerToken)}
                    </TableCell>
                    <TableCell>
                      {formatUnitPrice(price.outputNanoUsdPerToken)}
                    </TableCell>
                    <TableCell>
                      {formatUnitPrice(price.cachedInputNanoUsdPerToken)}
                    </TableCell>
                    <TableCell>
                      {formatUnitPrice(price.cacheWriteNanoUsdPerToken)}
                    </TableCell>
                    <TableCell>
                      {formatUnitPrice(price.reasoningNanoUsdPerToken)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`编辑 ${price.model} 的自定义价格`}
                          onClick={() => editModelPrice(price)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`删除 ${price.model} 的自定义价格`}
                          onClick={() => setPendingDelete(price)}
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

      <Card>
        <CardHeader>
          <CardTitle>模型成本剖析</CardTitle>
          <CardDescription>
            逐模型展示当前生效价格与累计用量；历史成本仍按请求发生时的价格快照计算。
            累计成本 {formatUsd(costs?.totalCostNanoUsd)}，共{" "}
            {costs?.pricedRequests ?? 0} 个已定价请求。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead>当前价格 / 1M Token</TableHead>
                <TableHead>请求</TableHead>
                <TableHead>输入</TableHead>
                <TableHead>输出</TableHead>
                <TableHead>缓存</TableHead>
                <TableHead className="text-right">换算成本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costs?.models.map((row) => (
                <TableRow key={row.model}>
                  <TableCell>{row.model}</TableCell>
                  <TableCell>
                    <ModelPrice value={row.pricing} />
                  </TableCell>
                  <TableCell>{row.requestCount}</TableCell>
                  <TableCell>{row.promptTokens.toLocaleString()}</TableCell>
                  <TableCell>{row.completionTokens.toLocaleString()}</TableCell>
                  <TableCell>{row.cachedTokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {formatUsd(row.costNanoUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deletingPrice) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这项自定义价格？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.model} 将恢复使用同步目录或内置价格。如果目录中也没有价格，后续请求会重新进入待定价状态。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingPrice}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingPrice}
              onClick={(event) => {
                event.preventDefault();
                void deleteModelPrice();
              }}
            >
              {deletingPrice && <Spinner data-icon="inline-start" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PriceField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

type ModelPriceInput = {
  inputNanoUsdPerToken: string;
  outputNanoUsdPerToken: string;
  cachedInputNanoUsdPerToken?: string;
  cacheWriteNanoUsdPerToken?: string;
  reasoningNanoUsdPerToken?: string;
};

function overridesPayload(overrides: ModelPricingOverride[]) {
  return Object.fromEntries(
    overrides.map((row) => [
      row.model,
      {
        inputNanoUsdPerToken: row.inputNanoUsdPerToken,
        outputNanoUsdPerToken: row.outputNanoUsdPerToken,
        cachedInputNanoUsdPerToken: row.cachedInputNanoUsdPerToken,
        cacheWriteNanoUsdPerToken: row.cacheWriteNanoUsdPerToken,
        reasoningNanoUsdPerToken: row.reasoningNanoUsdPerToken,
      },
    ]),
  ) as Record<string, ModelPriceInput>;
}

function formatUsd(value?: string | null) {
  return `$${(Number(value || 0) / 1_000_000_000).toFixed(4)}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未同步";
}

function ModelPrice({
  value,
}: {
  value: CostAnalysis["models"][number]["pricing"];
}) {
  return value ? (
    <div className="flex flex-col gap-1 font-mono text-xs">
      <span>
        输入 {formatUnitPrice(value.inputNanoUsdPerToken)} · 输出{" "}
        {formatUnitPrice(value.outputNanoUsdPerToken)}
      </span>
      <span className="text-muted-foreground">
        缓存读 {formatUnitPrice(value.cachedInputNanoUsdPerToken)} · 写{" "}
        {formatUnitPrice(value.cacheWriteNanoUsdPerToken)} · 推理{" "}
        {formatUnitPrice(value.reasoningNanoUsdPerToken)}
      </span>
    </div>
  ) : (
    <span className="text-muted-foreground">当前目录未定价</span>
  );
}

function formatUnitPrice(value: string) {
  return `$${nanoUsdPerTokenToUnitPrice(value)}`;
}

function nanoUsdPerTokenToUnitPrice(value: string) {
  return (Number(value) / 1_000).toFixed(4);
}

function positiveUnitPrice(value: string) {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && Math.round(parsed * 1_000) > 0;
}

function validOptionalUnitPrice(value: string) {
  return !value.trim() || positiveUnitPrice(value);
}

function unitPriceToNanoUsd(value: string) {
  return String(Math.round(Number(value.trim()) * 1_000));
}

function backfillLabel(value?: QuotaAdministration["pricing"]["backfill"]) {
  if (!value || value.status === "idle") return "尚未运行";
  if (value.status === "pending") return "等待执行";
  if (value.status === "running") return "核算中";
  if (value.status === "failed") return `失败：${value.error || "未知错误"}`;
  return `已完成，补算 ${value.updatedRequests} 条`;
}
