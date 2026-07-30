import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { AlertTriangleIcon, CircleDollarSignIcon, CloudDownloadIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  api,
  deleteRequest,
  type ModelAlias,
  type ModelPrice,
  type ModelPriceRule,
} from "@/lib/api"
import { dateTime } from "@/lib/format"

type HistoricalModelPrice = ModelPrice & {
  request_count: number
  latest_started_at: string
  priced: boolean
  priced_model: string
}

type PricesResponse = {
  items: ModelPrice[]
  catalog_items: ModelPrice[]
  bundled_items: ModelPrice[]
  pending_models: Array<{ model: string; request_count: number; latest_started_at: string }>
  history_items: HistoricalModelPrice[]
  catalog_sync_error?: string
}

export function PricingView() {
  const [prices, setPrices] = useState<PricesResponse>({ items: [], catalog_items: [], bundled_items: [], pending_models: [], history_items: [] })
  const [aliases, setAliases] = useState<ModelAlias[]>([])
  const [rules, setRules] = useState<ModelPriceRule[]>([])
  const [fields, setFields] = useState<string[]>([])
  const [open, setOpen] = useState(false)
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
        api<{ items: ModelPriceRule[]; fields: string[] }>("/api/admin/pricing/rules"),
      ])
      setPrices({
        items: priceValue.items ?? [],
        catalog_items: priceValue.catalog_items ?? [],
        bundled_items: priceValue.bundled_items ?? [],
        pending_models: priceValue.pending_models ?? [],
        history_items: priceValue.history_items ?? [],
        catalog_sync_error: priceValue.catalog_sync_error,
      })
      setAliases(aliasValue.items ?? [])
      setRules(ruleValue.items ?? [])
      setFields(ruleValue.fields ?? [])
      setAliasText(JSON.stringify(aliasValue.items ?? [], null, 2))
      setRuleText(JSON.stringify((ruleValue.items ?? []).map(({ model, field, value, multiplier }) => ({ model, field, value, multiplier })), null, 2))
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "读取定价失败")
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load().catch((cause) => toast.error(cause instanceof Error ? cause.message : "读取定价失败"))
  }, [load])

  const effectiveCatalog = prices.catalog_items.length ? prices.catalog_items : prices.bundled_items
  const filteredCatalog = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase()
    return effectiveCatalog.filter((price) => !query || price.model.toLowerCase().includes(query)).slice(0, 200)
  }, [catalogQuery, effectiveCatalog])

  async function savePrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const model = String(data.get("model") ?? "").trim()
    const perMillion = (name: string) => Math.round(Number(data.get(name) || 0) * 1000)
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
          price_multiplier: Number(data.get("multiplier") || 1),
        }),
      })
      setOpen(false)
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
      const result = await api<{ count: number; version: string; applied: boolean }>("/api/admin/pricing/sync", {
        method: apply ? "POST" : "GET",
      })
      if (apply) await load()
      toast.success(`${apply ? "已同步" : "同步预览"} ${result.count} 个价格，版本 ${result.version.slice(0, 20)}…`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "同步价格失败")
    } finally {
      setPending(false)
    }
  }

  async function saveJSON(kind: "aliases" | "rules") {
    try {
      const value = JSON.parse(kind === "aliases" ? aliasText : ruleText) as unknown[]
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
      await load()
      toast.success("已移除管理员覆盖，将回退到目录价格")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">模型定价</h1>
          <p className="text-sm text-muted-foreground">管理员覆盖 &gt; Models.dev 在线目录 &gt; 内置最后可用目录；每个请求保存不可变五段价格快照。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending} onClick={() => void syncCatalog(false)}><CloudDownloadIcon />预览同步</Button>
          <Button variant="outline" disabled={pending} onClick={() => void syncCatalog(true)}><CloudDownloadIcon />应用 Models.dev</Button>
          <Button onClick={() => setOpen(true)}><PlusIcon />添加覆盖</Button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="历史模型" value={prices.history_items.length} hint="请求日志中出现过" />
        <Stat label="管理员覆盖" value={prices.items.length} hint="最高优先级" />
        <Stat label="在线目录" value={prices.catalog_items.length} hint="Models.dev 快照" />
        <Stat label="内置兜底" value={prices.bundled_items.length} hint="离线最后可用" />
        <Stat label="待回填模型" value={prices.pending_models.length} hint="价格更新后自动回填" />
      </div>
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
      <Card>
        <CardHeader>
          <CardTitle>有效模型目录</CardTitle>
          <CardDescription>
            {prices.catalog_items.length ? `已自动加载 Models.dev 的 ${prices.catalog_items.length} 个模型。` : `在线目录不可用，展示 ${prices.bundled_items.length} 个内置兜底模型。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="relative max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <Input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="搜索模型" className="pl-9" />
          </div>
          {loading ? (
            <Empty>
              <EmptyHeader><EmptyMedia variant="icon"><Spinner /></EmptyMedia><EmptyTitle>正在加载模型价格</EmptyTitle></EmptyHeader>
            </Empty>
          ) : filteredCatalog.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>模型</TableHead><TableHead>来源</TableHead><TableHead className="text-right">输入</TableHead><TableHead className="text-right">缓存读</TableHead><TableHead className="text-right">缓存写</TableHead><TableHead className="text-right">输出</TableHead><TableHead className="text-right">推理</TableHead></TableRow></TableHeader>
              <TableBody>
                {filteredCatalog.map((price) => (
                  <TableRow key={price.model}>
                    <TableCell className="font-mono text-xs">{price.model}</TableCell>
                    <TableCell><Badge variant="outline">{priceSourceLabel(price.source)}</Badge></TableCell>
                    {[price.input_nano_usd_per_token, price.cached_input_nano_usd_per_token, price.cache_write_nano_usd_per_token, price.output_nano_usd_per_token, price.reasoning_nano_usd_per_token].map((value, index) => <TableCell key={index} className="text-right tabular-nums">{pricePerMillion(value)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader><EmptyMedia variant="icon"><SearchIcon /></EmptyMedia><EmptyTitle>没有匹配的模型</EmptyTitle><EmptyDescription>换一个模型名称，或重新应用 Models.dev 目录。</EmptyDescription></EmptyHeader>
            </Empty>
          )}
          {effectiveCatalog.length > 200 && filteredCatalog.length === 200 ? <p className="text-xs text-muted-foreground">当前最多显示 200 条，请通过搜索缩小范围。</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>历史模型价目表</CardTitle><CardDescription>请求日志中出现过的模型及其当前有效价格，单位为 USD / 1M tokens；多维规则仍按每次请求的上下文单独应用。</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>模型</TableHead><TableHead>来源</TableHead><TableHead className="text-right">输入</TableHead><TableHead className="text-right">缓存读</TableHead><TableHead className="text-right">缓存写</TableHead><TableHead className="text-right">输出</TableHead><TableHead className="text-right">推理</TableHead><TableHead className="text-right">倍率</TableHead><TableHead className="text-right">请求数</TableHead><TableHead>最近出现</TableHead></TableRow></TableHeader>
            <TableBody>
              {prices.history_items.map((price) => (
                <TableRow key={price.model}>
                  <TableCell className="font-mono text-xs">
                    {price.model}
                    {price.priced && price.priced_model !== price.model ? <p className="text-[10px] text-muted-foreground">按 {price.priced_model} 计价</p> : null}
                  </TableCell>
                  <TableCell>
                    {price.priced ? <Badge variant="outline">{priceSourceLabel(price.source)}</Badge> : <Badge variant="secondary">未定价</Badge>}
                  </TableCell>
                  {[price.input_nano_usd_per_token, price.cached_input_nano_usd_per_token, price.cache_write_nano_usd_per_token, price.output_nano_usd_per_token, price.reasoning_nano_usd_per_token].map((value, index) => <TableCell key={index} className="text-right tabular-nums">{price.priced ? pricePerMillion(value) : "—"}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{price.priced ? `×${price.price_multiplier}` : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{price.request_count.toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{dateTime(price.latest_started_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!prices.history_items.length ? <p className="py-8 text-center text-sm text-muted-foreground">请求历史中还没有模型记录。</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>管理员价格覆盖</CardTitle><CardDescription>单位为 USD / 1M tokens；内部转换为整数 nanoUSD/token。</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>模型</TableHead><TableHead className="text-right">输入</TableHead><TableHead className="text-right">缓存读</TableHead><TableHead className="text-right">缓存写</TableHead><TableHead className="text-right">输出</TableHead><TableHead className="text-right">推理</TableHead><TableHead>倍率</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {prices.items.map((price) => (
                <TableRow key={price.model}>
                  <TableCell className="font-mono text-xs">{price.model}<p className="text-[10px] text-muted-foreground">{price.version}</p></TableCell>
                  {[price.input_nano_usd_per_token, price.cached_input_nano_usd_per_token, price.cache_write_nano_usd_per_token, price.output_nano_usd_per_token, price.reasoning_nano_usd_per_token].map((value, index) => <TableCell key={index} className="text-right tabular-nums">{(value / 1000).toFixed(4)}</TableCell>)}
                  <TableCell><Badge variant="outline">×{price.price_multiplier}</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon-sm" onClick={() => void remove(price.model)}><Trash2Icon /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!prices.items.length ? <p className="py-8 text-center text-sm text-muted-foreground">没有管理员覆盖，当前使用在线或内置目录。</p> : null}
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>模型别名</CardTitle><CardDescription>请求模型先解析别名，再按来源优先级查价。</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={aliasText} onChange={(event) => setAliasText(event.target.value)} className="min-h-52 font-mono text-xs" />
            <Button variant="outline" onClick={() => void saveJSON("aliases")}>保存 {aliases.length} 条别名</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>CPA 多维倍率规则</CardTitle><CardDescription>可用字段：{fields.join("、")}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={ruleText} onChange={(event) => setRuleText(event.target.value)} className="min-h-52 font-mono text-xs" />
            <Button variant="outline" onClick={() => void saveJSON("rules")}>保存 {rules.length} 条规则</Button>
          </CardContent>
        </Card>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>添加管理员价格覆盖</DialogTitle><DialogDescription>价格单位为 USD / 1M tokens，支持整体倍率为 0 的免费模型。</DialogDescription></DialogHeader>
          <form id="price-form" onSubmit={savePrice}>
            <FieldGroup>
              <Field><FieldLabel>模型</FieldLabel><Input name="model" placeholder="provider/model 或 model" required /></Field>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ["input", "普通输入"], ["cached", "缓存读取"], ["cacheWrite", "缓存写入"],
                  ["output", "输出"], ["reasoning", "推理"], ["multiplier", "整体倍率"],
                ].map(([name, label]) => (
                  <Field key={name}><FieldLabel>{label}</FieldLabel><Input name={name} type="number" min="0" step="any" defaultValue={name === "multiplier" ? "1" : "0"} required /></Field>
                ))}
              </div>
            </FieldGroup>
          </form>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button form="price-form" type="submit" disabled={pending}>{pending ? <Spinner /> : <CircleDollarSignIcon />}保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{hint}</p></CardContent></Card>
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
