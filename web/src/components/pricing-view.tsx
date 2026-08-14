import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import {
  AlertTriangleIcon,
  CircleDollarSignIcon,
  CloudDownloadIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { PageHeader, SearchField, StatStrip } from "@/components/workspace-ui"
import {
  api,
  deleteRequest,
  type ModelAlias,
  type ModelPrice,
  type ModelPriceRule,
} from "@/lib/api"
type AvailableModelPrice = ModelPrice & {
  priced: boolean
  priced_model: string
}

type PricesResponse = {
  available_models: AvailableModelPrice[]
  catalog_sync_error?: string
  available_models_error?: string
}

export function PricingView() {
  const [prices, setPrices] = useState<PricesResponse>({ available_models: [] })
  const [aliases, setAliases] = useState<ModelAlias[]>([])
  const [rules, setRules] = useState<ModelPriceRule[]>([])
  const [fields, setFields] = useState<string[]>([])
  const [editingPrice, setEditingPrice] = useState<AvailableModelPrice | null>(
    null
  )
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [catalogQuery, setCatalogQuery] = useState("")
  const [aliasText, setAliasText] = useState("[]")
  const [ruleText, setRuleText] = useState("[]")

  const load = useCallback(async () => {
    setLoadError("")
    try {
      const [priceValue, aliasValue, ruleValue] = await Promise.all([
        api<PricesResponse>("/api/admin/prices"),
        api<{ items: ModelAlias[] }>("/api/admin/pricing/aliases"),
        api<{ items: ModelPriceRule[]; fields: string[] }>(
          "/api/admin/pricing/rules"
        ),
      ])
      setPrices({
        available_models: priceValue.available_models ?? [],
        catalog_sync_error: priceValue.catalog_sync_error,
        available_models_error: priceValue.available_models_error,
      })
      setAliases(aliasValue.items ?? [])
      setRules(ruleValue.items ?? [])
      setFields(ruleValue.fields ?? [])
      setAliasText(JSON.stringify(aliasValue.items ?? [], null, 2))
      setRuleText(
        JSON.stringify(
          (ruleValue.items ?? []).map(
            ({ model, field, value, multiplier }) => ({
              model,
              field,
              value,
              multiplier,
            })
          ),
          null,
          2
        )
      )
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "读取定价失败")
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load().catch((cause) =>
      toast.error(cause instanceof Error ? cause.message : "读取定价失败")
    )
  }, [load])

  const filteredModels = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase()
    return prices.available_models.filter(
      (price) => !query || price.model.toLowerCase().includes(query)
    )
  }, [catalogQuery, prices.available_models])

  async function savePrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const model = String(data.get("model") ?? "").trim()
    const perMillion = (name: string) =>
      Math.round(Number(data.get(name) || 0) * 1000)
    setPending(true)
    try {
      await api(`/api/admin/prices/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_nano_usd_per_token: perMillion("input"),
          output_nano_usd_per_token: perMillion("output"),
          cached_input_nano_usd_per_token: perMillion("cached"),
          cache_write_nano_usd_per_token: perMillion("cacheWrite"),
          reasoning_nano_usd_per_token: perMillion("reasoning"),
          image_input_nano_usd_per_token: perMillion("imageInput"),
          cached_image_input_nano_usd_per_token: perMillion("cachedImageInput"),
          image_output_nano_usd_per_token: perMillion("imageOutput"),
          price_multiplier: Number(data.get("multiplier") || 1),
        }),
      })
      setEditingPrice(null)
      await load()
      toast.success("管理员价格覆盖已保存")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存价格失败")
    } finally {
      setPending(false)
    }
  }

  async function syncCatalog(apply: boolean) {
    setPending(true)
    try {
      const result = await api<{
        count: number
        version: string
        applied: boolean
      }>("/api/admin/pricing/sync", {
        method: apply ? "POST" : "GET",
      })
      if (apply) await load()
      toast.success(
        `${apply ? "已同步" : "同步预览"} ${result.count} 个价格，版本 ${result.version.slice(0, 20)}…`
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "同步价格失败")
    } finally {
      setPending(false)
    }
  }

  async function saveJSON(kind: "aliases" | "rules") {
    try {
      const value = JSON.parse(
        kind === "aliases" ? aliasText : ruleText
      ) as unknown[]
      await api(`/api/admin/pricing/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: value }),
      })
      await load()
      toast.success(kind === "aliases" ? "模型别名已保存" : "定价规则已保存")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "JSON 或规则无效")
    }
  }

  async function remove(model: string) {
    try {
      await deleteRequest(`/api/admin/prices/${encodeURIComponent(model)}`)
      setEditingPrice(null)
      await load()
      toast.success("已移除管理员覆盖，将回退到目录价格")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="模型定价"
        actions={
          <>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void syncCatalog(false)}
            >
              <CloudDownloadIcon />
              预览同步
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void syncCatalog(true)}
            >
              <CloudDownloadIcon />
              应用 Models.dev
            </Button>
          </>
        }
      />
      <StatStrip
        className="sm:grid-cols-4"
        items={[
          { label: "已接入模型", value: prices.available_models.length },
          {
            label: "已定价",
            value: prices.available_models.filter((item) => item.priced).length,
          },
          {
            label: "未定价",
            value: prices.available_models.filter((item) => !item.priced)
              .length,
          },
          {
            label: "管理员覆盖",
            value: prices.available_models.filter(
              (item) => item.source === "admin"
            ).length,
          },
        ]}
      />
      {loadError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>定价数据加载失败</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}
      {prices.catalog_sync_error ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Models.dev 暂时不可用，当前使用内置目录</AlertTitle>
          <AlertDescription>{prices.catalog_sync_error}</AlertDescription>
        </Alert>
      ) : null}
      {prices.available_models_error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>无法读取本站模型</AlertTitle>
          <AlertDescription>{prices.available_models_error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>已接入模型价目表</CardTitle>
          <CardDescription>
            模型来自 native 运行时目录。文本与图片 token 分模态计价，单位为 USD
            / 1M tokens。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SearchField
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            onClear={() => setCatalogQuery("")}
            placeholder="搜索模型"
            className="max-w-sm"
          />
          {loading ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Spinner />
                </EmptyMedia>
                <EmptyTitle>正在加载模型价格</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : filteredModels.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead className="text-right">文本输入</TableHead>
                  <TableHead className="text-right">文本缓存</TableHead>
                  <TableHead className="text-right">缓存写入</TableHead>
                  <TableHead className="text-right">图片输入</TableHead>
                  <TableHead className="text-right">图片缓存</TableHead>
                  <TableHead className="text-right">图片输出</TableHead>
                  <TableHead className="text-right">文本输出</TableHead>
                  <TableHead className="text-right">推理</TableHead>
                  <TableHead className="text-right">倍率</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredModels.map((price) => (
                  <TableRow key={price.model}>
                    <TableCell className="font-mono text-xs">
                      {price.model}
                      {price.priced && price.priced_model !== price.model ? (
                        <p className="text-[10px] text-muted-foreground">
                          按 {price.priced_model} 计价
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {price.priced ? (
                        <Badge variant="outline">
                          {priceSourceLabel(price.source)}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">未定价</Badge>
                      )}
                    </TableCell>
                    {[
                      price.input_nano_usd_per_token,
                      price.cached_input_nano_usd_per_token,
                      price.cache_write_nano_usd_per_token,
                      price.image_input_nano_usd_per_token,
                      price.cached_image_input_nano_usd_per_token,
                      price.image_output_nano_usd_per_token,
                      price.output_nano_usd_per_token,
                      price.reasoning_nano_usd_per_token,
                    ].map((value, index) => (
                      <TableCell
                        key={index}
                        className="text-right tabular-nums"
                      >
                        {price.priced ? pricePerMillion(value) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      {price.priced ? `×${price.price_multiplier}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`配置 ${price.model} 的价格`}
                          onClick={() => setEditingPrice(price)}
                        >
                          <PencilIcon />
                        </Button>
                        {price.source === "admin" ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除 ${price.model} 的管理员价格`}
                            onClick={() => void remove(price.model)}
                          >
                            <Trash2Icon />
                          </Button>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {prices.available_models.length
                    ? "没有匹配的模型"
                    : "本站尚未接入模型"}
                </EmptyTitle>
                <EmptyDescription>
                  {prices.available_models.length
                    ? "换一个模型名称。"
                    : "在提供商页面接入账户后，模型会自动出现在这里。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>模型别名</CardTitle>
            <CardDescription>
              请求模型先解析别名，再按来源优先级查价。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              value={aliasText}
              onChange={(event) => setAliasText(event.target.value)}
              className="min-h-52 font-mono text-xs"
            />
            <Button variant="outline" onClick={() => void saveJSON("aliases")}>
              保存 {aliases.length} 条别名
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>多维倍率规则</CardTitle>
            <CardDescription>可用字段：{fields.join("、")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              value={ruleText}
              onChange={(event) => setRuleText(event.target.value)}
              className="min-h-52 font-mono text-xs"
            />
            <Button variant="outline" onClick={() => void saveJSON("rules")}>
              保存 {rules.length} 条规则
            </Button>
          </CardContent>
        </Card>
      </div>
      <Dialog
        open={Boolean(editingPrice)}
        onOpenChange={(open) => {
          if (!open) setEditingPrice(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>配置模型价格</DialogTitle>
            <DialogDescription>
              保存后将创建本站管理员价格覆盖。文本和图片 token 独立计价，单位为
              USD / 1M tokens。
            </DialogDescription>
          </DialogHeader>
          <form id="price-form" key={editingPrice?.model} onSubmit={savePrice}>
            <FieldGroup>
              <Field>
                <FieldLabel>模型</FieldLabel>
                <Input
                  name="model"
                  value={editingPrice?.model ?? ""}
                  readOnly
                />
              </Field>
              <FieldGroup className="grid gap-3 sm:grid-cols-3">
                {[
                  ["input", "普通输入", editingPrice?.input_nano_usd_per_token],
                  [
                    "cached",
                    "缓存读取",
                    editingPrice?.cached_input_nano_usd_per_token,
                  ],
                  [
                    "cacheWrite",
                    "缓存写入",
                    editingPrice?.cache_write_nano_usd_per_token,
                  ],
                  ["output", "输出", editingPrice?.output_nano_usd_per_token],
                  [
                    "reasoning",
                    "推理",
                    editingPrice?.reasoning_nano_usd_per_token,
                  ],
                  [
                    "multiplier",
                    "整体倍率",
                    editingPrice?.price_multiplier ?? 1,
                  ],
                  [
                    "imageInput",
                    "图片输入",
                    editingPrice?.image_input_nano_usd_per_token,
                  ],
                  [
                    "cachedImageInput",
                    "图片缓存读取",
                    editingPrice?.cached_image_input_nano_usd_per_token,
                  ],
                  [
                    "imageOutput",
                    "图片输出",
                    editingPrice?.image_output_nano_usd_per_token,
                  ],
                ].map(([name, label, value]) => (
                  <Field key={String(name)}>
                    <FieldLabel>{label}</FieldLabel>
                    <Input
                      name={String(name)}
                      type="number"
                      min="0"
                      step="any"
                      defaultValue={
                        name === "multiplier"
                          ? Number(value)
                          : pricePerMillion(Number(value ?? 0))
                      }
                      required
                    />
                  </Field>
                ))}
              </FieldGroup>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingPrice(null)}>
              取消
            </Button>
            <Button form="price-form" type="submit" disabled={pending}>
              {pending ? (
                <Spinner />
              ) : (
                <CircleDollarSignIcon data-icon="inline-start" />
              )}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function pricePerMillion(value: number) {
  return (value / 1000).toFixed(4)
}

function priceSourceLabel(source: string) {
  if (source === "admin") return "管理员覆盖"
  if (source === "models.dev") return "Models.dev"
  if (source === "bundled") return "内置兜底"
  return source || "未知"
}
