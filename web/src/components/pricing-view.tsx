import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  CircleDollarSignIcon,
  CloudDownloadIcon,
  PencilIcon,
  Search01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"

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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
      setLoadError(cause instanceof Error ? cause.message : "读取模型设置失败")
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load().catch((cause) =>
      toast.add({
        title: cause instanceof Error ? cause.message : "读取模型设置失败",
        type: "error",
      })
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
      const efforts = data.getAll("reasoning_effort").map(String)
      const modalities = data.getAll("input_modality").map(String)
      const websocket = String(data.get("prefer_websockets") ?? "")
      await api(`/api/admin/model-settings/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: String(data.get("display_name") ?? "").trim(),
          context_window: Number(data.get("context_window") || 0),
          max_output_tokens: Number(data.get("max_output_tokens") || 0),
          reasoning_efforts: efforts,
          default_reasoning_level: String(
            data.get("default_reasoning_level") ?? ""
          ).trim(),
          input_modalities: modalities,
          prefer_websockets:
            websocket === "true" ? true : websocket === "false" ? false : null,
          provider: String(data.get("provider") ?? "").trim(),
        }),
      })
      toast.add({ title: "模型设置已保存", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存模型设置失败",
        type: "error",
      })
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
      toast.add({
        title: `${apply ? "已同步" : "同步预览"} ${result.count} 个价格，版本 ${result.version.slice(0, 20)}…`,
        type: "success",
      })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "同步价格失败",
        type: "error",
      })
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
      toast.add({
        title: kind === "aliases" ? "模型别名已保存" : "定价规则已保存",
        type: "success",
      })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "JSON 或规则无效",
        type: "error",
      })
    }
  }

  async function removeCapability(model: string) {
    try {
      await deleteRequest(
        `/api/admin/model-settings/${encodeURIComponent(model)}`
      )
      setEditingPrice(null)
      await load()
      toast.add({
        title: "已移除能力覆盖，将回退到 Models.dev 或模板",
        type: "success",
      })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除能力覆盖失败",
        type: "error",
      })
    }
  }

  async function remove(model: string) {
    try {
      await deleteRequest(`/api/admin/prices/${encodeURIComponent(model)}`)
      setEditingPrice(null)
      await load()
      toast.add({
        title: "已移除管理员价格覆盖，将回退到目录价格",
        type: "success",
      })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除失败",
        type: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="目录与计费"
        actions={
          <>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void syncCatalog(false)}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={CloudDownloadIcon}
                data-icon="inline-start"
              />
              预览同步
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void syncCatalog(true)}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={CloudDownloadIcon}
                data-icon="inline-start"
              />
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
          <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} />
          <AlertTitle>定价数据加载失败</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}
      {prices.catalog_sync_error ? (
        <Alert>
          <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} />
          <AlertTitle>Models.dev 暂时不可用，当前使用内置目录</AlertTitle>
          <AlertDescription>{prices.catalog_sync_error}</AlertDescription>
        </Alert>
      ) : null}
      {prices.available_models_error ? (
        <Alert variant="destructive">
          <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} />
          <AlertTitle>无法读取本站模型</AlertTitle>
          <AlertDescription>{prices.available_models_error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>已接入模型</CardTitle>
          <CardDescription>
            计价仍按 USD / 1M tokens。能力元数据优先用本页覆盖，其次
            Models.dev，最后才是 Codex 模板。用来补 models.dev
            没有或不对的条目，例如 Kimi Coding Plan 的 kimi-k3-256k。
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
                  <TableHead>能力</TableHead>
                  <TableHead className="text-right">上下文</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead className="text-right">输入 / 百万</TableHead>
                  <TableHead className="text-right">输出 / 百万</TableHead>
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
                      <Badge variant="outline">
                        {capabilitySourceLabel(price.capability_source)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price.context_window
                        ? price.context_window.toLocaleString("en-US")
                        : "—"}
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
                    <TableCell className="text-right tabular-nums">
                      {price.priced
                        ? pricePerMillion(price.input_nano_usd_per_token)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price.priced
                        ? pricePerMillion(price.output_nano_usd_per_token)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price.priced ? `×${price.price_multiplier}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`配置 ${price.model}`}
                          onClick={() => setEditingPrice(price)}
                        >
                          <HugeiconsIcon strokeWidth={2} icon={PencilIcon} />
                        </Button>
                        {price.source === "admin" ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除 ${price.model} 的管理员价格`}
                            onClick={() => void remove(price.model)}
                          >
                            <HugeiconsIcon
                              strokeWidth={2}
                              icon={Delete02Icon}
                            />
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
                  <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
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
            <DialogTitle>{editingPrice?.model ?? "模型设置"}</DialogTitle>
          </DialogHeader>
          <form id="price-form" key={editingPrice?.model} onSubmit={savePrice}>
            <FieldGroup>
              <input
                type="hidden"
                name="model"
                value={editingPrice?.model ?? ""}
              />
              <FieldSet>
                <FieldLegend>能力元数据</FieldLegend>
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>显示名</FieldLabel>
                    <Input
                      name="display_name"
                      defaultValue={editingPrice?.display_name ?? ""}
                      placeholder="Kimi K3 256k"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>提供商</FieldLabel>
                    <Input
                      name="provider"
                      defaultValue={inferredProvider(editingPrice?.model)}
                      placeholder="moonshotai"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>上下文窗口</FieldLabel>
                    <Input
                      name="context_window"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={editingPrice?.context_window ?? 0}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>最大输出</FieldLabel>
                    <Input
                      name="max_output_tokens"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={editingPrice?.max_output_tokens ?? 0}
                    />
                  </Field>
                </FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">推理档位</FieldLegend>
                  <FieldGroup className="flex flex-row flex-wrap gap-3">
                    {reasoningEffortOptions.map((effort) => (
                      <Field
                        key={effort}
                        orientation="horizontal"
                        className="w-auto items-center"
                      >
                        <Checkbox
                          id={`reasoning-effort-${effort}`}
                          name="reasoning_effort"
                          value={effort}
                          defaultChecked={editingPrice?.reasoning_efforts?.includes(
                            effort
                          )}
                        />
                        <FieldLabel htmlFor={`reasoning-effort-${effort}`}>
                          {effort}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>默认推理</FieldLabel>
                    <Select
                      items={defaultReasoningItems}
                      name="default_reasoning_level"
                      defaultValue={
                        editingPrice?.default_reasoning_level ?? null
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {defaultReasoningItems.map((item) => (
                            <SelectItem
                              key={item.value ?? "automatic"}
                              value={item.value}
                            >
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>WebSocket</FieldLabel>
                    <Select
                      items={websocketItems}
                      name="prefer_websockets"
                      defaultValue={
                        editingPrice?.prefer_websockets === true
                          ? "true"
                          : editingPrice?.prefer_websockets === false
                            ? "false"
                            : null
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {websocketItems.map((item) => (
                            <SelectItem
                              key={item.value ?? "provider"}
                              value={item.value}
                            >
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">输入模态</FieldLegend>
                  <FieldGroup className="flex flex-row flex-wrap gap-3">
                    {["text", "image"].map((modality) => (
                      <Field
                        key={modality}
                        orientation="horizontal"
                        className="w-auto items-center"
                      >
                        <Checkbox
                          id={`input-modality-${modality}`}
                          name="input_modality"
                          value={modality}
                          defaultChecked={
                            editingPrice?.input_modalities?.includes(
                              modality
                            ) ?? modality === "text"
                          }
                        />
                        <FieldLabel htmlFor={`input-modality-${modality}`}>
                          {modality}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              </FieldSet>
              <FieldSet>
                <FieldLegend>计价（USD / 百万 Tokens）</FieldLegend>
                <FieldGroup className="grid gap-3 sm:grid-cols-3">
                  {[
                    [
                      "input",
                      "普通输入",
                      editingPrice?.input_nano_usd_per_token,
                    ],
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
              </FieldSet>
            </FieldGroup>
          </form>
          <DialogFooter>
            {editingPrice?.capability_source === "admin" ? (
              <Button
                variant="outline"
                onClick={() => void removeCapability(editingPrice.model)}
              >
                清除能力覆盖
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setEditingPrice(null)}>
              取消
            </Button>
            <Button form="price-form" type="submit" disabled={pending}>
              {pending ? (
                <Spinner />
              ) : (
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={CircleDollarSignIcon}
                  data-icon="inline-start"
                />
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

function capabilitySourceLabel(source?: string) {
  if (source === "admin") return "管理员覆盖"
  if (source === "models.dev") return "Models.dev"
  return "模板"
}

const reasoningEffortOptions = ["none", "low", "medium", "high", "xhigh", "max"]

const defaultReasoningItems = [
  { value: null, label: "自动" },
  ...reasoningEffortOptions.map((value) => ({ value, label: value })),
]

const websocketItems = [
  { value: null, label: "跟随提供商" },
  { value: "false", label: "关闭" },
  { value: "true", label: "开启" },
]

function inferredProvider(model?: string) {
  const value = model?.toLowerCase() ?? ""
  if (value.startsWith("kimi-")) return "moonshotai"
  if (value.startsWith("deepseek-")) return "deepseek"
  if (value.startsWith("grok-")) return "xai"
  if (
    value.startsWith("gpt-") ||
    value.startsWith("o1-") ||
    value.startsWith("o3-") ||
    value.startsWith("o4-") ||
    value.startsWith("codex-")
  ) {
    return "openai"
  }
  return ""
}
