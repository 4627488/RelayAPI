import { useCallback, useEffect, useMemo, useState } from "react"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Grid } from "@astryxdesign/core/Grid"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  VStack,
} from "@astryxdesign/core/Layout"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { Token } from "@astryxdesign/core/Token"
import { useToast } from "@astryxdesign/core/Toast"
import {
  CircleDollarSignIcon,
  CloudDownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"

import { LoadingView } from "@/components/loading-view"
import {
  PageFrame,
  PageSection,
  SearchField,
  StatusLabel,
} from "@/components/page-kit"
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

type WebsocketChoice = "inherit" | "true" | "false"

type PriceForm = {
  display_name: string
  provider: string
  context_window: number
  max_output_tokens: number
  reasoning_efforts: string[]
  default_reasoning_level: string
  input_modalities: string[]
  prefer_websockets: WebsocketChoice
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  multiplier: number
  imageInput: number
  cachedImageInput: number
  imageOutput: number
}

interface PriceRow extends Record<string, unknown> {
  id: string
  price: AvailableModelPrice
}

const reasoningEffortOptions = ["none", "low", "medium", "high", "xhigh", "max"]

function emptyForm(): PriceForm {
  return {
    display_name: "",
    provider: "",
    context_window: 0,
    max_output_tokens: 0,
    reasoning_efforts: [],
    default_reasoning_level: "",
    input_modalities: ["text"],
    prefer_websockets: "inherit",
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    multiplier: 1,
    imageInput: 0,
    cachedImageInput: 0,
    imageOutput: 0,
  }
}

function formFromPrice(price: AvailableModelPrice): PriceForm {
  return {
    display_name: price.display_name ?? "",
    provider: inferredProvider(price.model),
    context_window: price.context_window ?? 0,
    max_output_tokens: price.max_output_tokens ?? 0,
    reasoning_efforts: [...(price.reasoning_efforts ?? [])],
    default_reasoning_level: price.default_reasoning_level ?? "",
    input_modalities: price.input_modalities
      ? [...price.input_modalities]
      : ["text"],
    prefer_websockets:
      price.prefer_websockets === true
        ? "true"
        : price.prefer_websockets === false
          ? "false"
          : "inherit",
    input: millionFromNano(price.input_nano_usd_per_token),
    cached: millionFromNano(price.cached_input_nano_usd_per_token),
    cacheWrite: millionFromNano(price.cache_write_nano_usd_per_token),
    output: millionFromNano(price.output_nano_usd_per_token),
    reasoning: millionFromNano(price.reasoning_nano_usd_per_token),
    multiplier: price.price_multiplier ?? 1,
    imageInput: millionFromNano(price.image_input_nano_usd_per_token),
    cachedImageInput: millionFromNano(
      price.cached_image_input_nano_usd_per_token
    ),
    imageOutput: millionFromNano(price.image_output_nano_usd_per_token),
  }
}

export function PricingView() {
  const toast = useToast()
  const [prices, setPrices] = useState<PricesResponse>({ available_models: [] })
  const [aliases, setAliases] = useState<ModelAlias[]>([])
  const [rules, setRules] = useState<ModelPriceRule[]>([])
  const [, setFields] = useState<string[]>([])
  const [editingPrice, setEditingPrice] = useState<AvailableModelPrice | null>(
    null
  )
  const [form, setForm] = useState<PriceForm>(emptyForm)
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
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "读取模型设置失败",
      })
    )
  }, [load, toast])

  const filteredModels = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase()
    return prices.available_models.filter(
      (price) => !query || price.model.toLowerCase().includes(query)
    )
  }, [catalogQuery, prices.available_models])

  function openEdit(price: AvailableModelPrice) {
    setForm(formFromPrice(price))
    setEditingPrice(price)
  }

  function patchForm<K extends keyof PriceForm>(key: K, next: PriceForm[K]) {
    setForm((current) => ({ ...current, [key]: next }))
  }

  function toggleList(key: "reasoning_efforts" | "input_modalities", item: string) {
    setForm((current) => {
      const selected = current[key]
      return {
        ...current,
        [key]: selected.includes(item)
          ? selected.filter((value) => value !== item)
          : [...selected, item],
      }
    })
  }

  async function savePrice() {
    if (!editingPrice) return
    const model = editingPrice.model
    const payload = form
    setPending(true)
    try {
      await api(`/api/admin/prices/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_nano_usd_per_token: nanoFromMillion(payload.input),
          output_nano_usd_per_token: nanoFromMillion(payload.output),
          cached_input_nano_usd_per_token: nanoFromMillion(payload.cached),
          cache_write_nano_usd_per_token: nanoFromMillion(payload.cacheWrite),
          reasoning_nano_usd_per_token: nanoFromMillion(payload.reasoning),
          image_input_nano_usd_per_token: nanoFromMillion(payload.imageInput),
          cached_image_input_nano_usd_per_token: nanoFromMillion(
            payload.cachedImageInput
          ),
          image_output_nano_usd_per_token: nanoFromMillion(payload.imageOutput),
          price_multiplier: Number(payload.multiplier || 1),
        }),
      })
      setEditingPrice(null)
      await load()
      await api(`/api/admin/model-settings/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: payload.display_name.trim(),
          context_window: Number(payload.context_window || 0),
          max_output_tokens: Number(payload.max_output_tokens || 0),
          reasoning_efforts: payload.reasoning_efforts,
          default_reasoning_level: payload.default_reasoning_level.trim(),
          input_modalities: payload.input_modalities,
          prefer_websockets:
            payload.prefer_websockets === "true"
              ? true
              : payload.prefer_websockets === "false"
                ? false
                : null,
          provider: payload.provider.trim(),
        }),
      })
      toast({ body: "模型设置已保存" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存模型设置失败",
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
      toast({
        body: `${apply ? "已同步" : "同步预览"} ${result.count} 个价格，版本 ${result.version.slice(0, 20)}…`,
      })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "同步价格失败",
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
      toast({
        body: kind === "aliases" ? "模型别名已保存" : "定价规则已保存",
      })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "JSON 或规则无效",
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
      toast({ body: "已移除能力覆盖，将回退到 Models.dev 或模板" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除能力覆盖失败",
      })
    }
  }

  async function remove(model: string) {
    try {
      await deleteRequest(`/api/admin/prices/${encodeURIComponent(model)}`)
      setEditingPrice(null)
      await load()
      toast({ body: "已移除管理员价格覆盖，将回退到目录价格" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除失败",
      })
    }
  }

  if (loading) return <LoadingView />

  const rows: PriceRow[] = filteredModels.map((price) => ({
    id: price.model,
    price,
  }))

  return (
    <>
    <PageFrame
      title="定价"
      accessory={
        <SearchField
          value={catalogQuery}
          onChange={setCatalogQuery}
          placeholder="搜索"
        />
      }
      actions={
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Button
            label="预览同步"
            icon={<CloudDownloadIcon />}
            isDisabled={pending}
            onClick={() => void syncCatalog(false)}
          />
          <Button
            label="应用 Models.dev"
            icon={<CloudDownloadIcon />}
            isDisabled={pending}
            onClick={() => void syncCatalog(true)}
          />
        </HStack>
      }
    >
      <VStack gap={0}>
      {loadError ? (
        <Banner
          status="error"
          title={loadError}
          collapsible={false}
        />
      ) : null}
      {prices.catalog_sync_error ? (
        <Banner
          status="warning"
          title={prices.catalog_sync_error}
          collapsible={false}
        />
      ) : null}
      {prices.available_models_error ? (
        <Banner
          status="error"
          title={prices.available_models_error}
          collapsible={false}
        />
      ) : null}
          {rows.length ? (
            <Table
              data={rows}
              idKey="id"
              density="compact"
              hasHover
              columns={[
                {
                  key: "model",
                  header: "模型",
                  width: proportional(2),
                  renderCell: (row) => (
                    <VStack gap={1}>
                      <Text type="code">{row.price.model}</Text>
                      {row.price.priced &&
                      row.price.priced_model !== row.price.model ? (
                        <Text color="secondary" type="supporting">
                          按 {row.price.priced_model} 计价
                        </Text>
                      ) : null}
                    </VStack>
                  ),
                },
                {
                  key: "capability",
                  header: "能力",
                  width: pixel(120),
                  renderCell: (row) => (
                    <Token
                      label={capabilitySourceLabel(row.price.capability_source)}
                      color="gray"
                    />
                  ),
                },
                {
                  key: "context_window",
                  header: "上下文",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.context_window
                        ? row.price.context_window.toLocaleString("en-US")
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "reasoning",
                  header: "推理",
                  width: pixel(140),
                  renderCell: (row) => (
                    <Text type="code">
                      {row.price.reasoning_efforts?.length
                        ? row.price.reasoning_efforts.join("/")
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "source",
                  header: "来源",
                  width: pixel(120),
                  renderCell: (row) =>
                    row.price.priced ? (
                      <Token
                        label={priceSourceLabel(row.price.source)}
                        color={row.price.source === "admin" ? "blue" : "gray"}
                      />
                    ) : (
                      <StatusLabel tone="neutral" label="未定价" />
                    ),
                },
                {
                  key: "input",
                  header: "文本输入",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(row.price.input_nano_usd_per_token)
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "cached",
                  header: "文本缓存",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.cached_input_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "cacheWrite",
                  header: "缓存写入",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.cache_write_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "imageInput",
                  header: "图片输入",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.image_input_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "cachedImageInput",
                  header: "图片缓存",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.cached_image_input_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "imageOutput",
                  header: "图片输出",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.image_output_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "output",
                  header: "文本输出",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(row.price.output_nano_usd_per_token)
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "reasoningPrice",
                  header: "推理",
                  width: pixel(100),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? pricePerMillion(
                            row.price.reasoning_nano_usd_per_token
                          )
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "multiplier",
                  header: "倍率",
                  width: pixel(80),
                  align: "end",
                  renderCell: (row) => (
                    <Text>
                      {row.price.priced
                        ? `×${row.price.price_multiplier}`
                        : "—"}
                    </Text>
                  ),
                },
                {
                  key: "actions",
                  header: "操作",
                  width: pixel(72),
                  align: "end",
                  renderCell: (row) => (
                    <DropdownMenu
                      hasChevron={false}
                      button={{
                        label: `操作 ${row.price.model}`,
                        variant: "ghost",
                        isIconOnly: true,
                        icon: <MoreHorizontalIcon />,
                      }}
                      items={[
                        {
                          label: "编辑",
                          icon: <PencilIcon />,
                          onClick: () => openEdit(row.price),
                        },
                        ...(row.price.source === "admin"
                          ? [
                              { type: "divider" as const },
                              {
                                label: "删除价格覆盖",
                                icon: <Trash2Icon />,
                                variant: "destructive" as const,
                                onClick: () => void remove(row.price.model),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState
              title={
                prices.available_models.length
                  ? "没有匹配的模型"
                  : "尚未接入模型"
              }
              icon={<SearchIcon />}
            />
          )}
      <Grid columns={{ minWidth: 320, max: 2 }} gap={0}>
        <PageSection
          title="别名"
          actions={
            <Button
              label={`保存 ${aliases.length} 条`}
              onClick={() => void saveJSON("aliases")}
            />
          }
        >
          <TextArea
            label="模型别名 JSON"
            value={aliasText}
            onChange={setAliasText}
          />
        </PageSection>
        <PageSection
          title="倍率规则"
          actions={
            <Button
              label={`保存 ${rules.length} 条`}
              onClick={() => void saveJSON("rules")}
            />
          }
        >
          <TextArea
            label="定价规则 JSON"
            value={ruleText}
            onChange={setRuleText}
          />
        </PageSection>
      </Grid>
      </VStack>
    </PageFrame>
      <Dialog
        isOpen={Boolean(editingPrice)}
        onOpenChange={(open) => {
          if (!open) setEditingPrice(null)
        }}
        width={720}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="配置模型设置"
              subtitle="能力覆盖会写进 Codex 目录，优先于 Models.dev。价格覆盖只影响本站计费，单位为 USD / 1M tokens。"
              onOpenChange={(open) => {
                if (!open) setEditingPrice(null)
              }}
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <TextInput
                  label="模型"
                  value={editingPrice?.model ?? ""}
                  isReadOnly
                  onChange={() => {}}
                />
                <Text weight="semibold">能力元数据</Text>
                <FormLayout direction="horizontal">
                  <TextInput
                    label="显示名"
                    value={form.display_name}
                    onChange={(value) => patchForm("display_name", value)}
                    placeholder="Kimi K3 256k"
                  />
                  <TextInput
                    label="提供商"
                    value={form.provider}
                    onChange={(value) => patchForm("provider", value)}
                    placeholder="moonshotai"
                  />
                </FormLayout>
                <FormLayout direction="horizontal">
                  <NumberInput
                    label="上下文窗口"
                    value={form.context_window}
                    onChange={(value) =>
                      patchForm("context_window", value ?? 0)
                    }
                    min={0}
                    isIntegerOnly
                  />
                  <NumberInput
                    label="最大输出"
                    value={form.max_output_tokens}
                    onChange={(value) =>
                      patchForm("max_output_tokens", value ?? 0)
                    }
                    min={0}
                    isIntegerOnly
                  />
                </FormLayout>
                <VStack gap={2}>
                  <Text>推理档位</Text>
                  <FormLayout direction="horizontal">
                    {reasoningEffortOptions.map((effort) => (
                      <CheckboxInput
                        key={effort}
                        label={effort}
                        value={form.reasoning_efforts.includes(effort)}
                        onChange={() => toggleList("reasoning_efforts", effort)}
                      />
                    ))}
                  </FormLayout>
                </VStack>
                <Selector
                  label="默认推理"
                  value={form.default_reasoning_level || "auto"}
                  onChange={(value) =>
                    patchForm(
                      "default_reasoning_level",
                      value === "auto" ? "" : value
                    )
                  }
                  options={[
                    { value: "auto", label: "自动" },
                    ...reasoningEffortOptions.map((effort) => ({
                      value: effort,
                      label: effort,
                    })),
                  ]}
                />
                <SegmentedControl
                  label="WebSocket"
                  value={form.prefer_websockets}
                  onChange={(value) =>
                    patchForm("prefer_websockets", value as WebsocketChoice)
                  }
                >
                  <SegmentedControlItem value="inherit" label="跟随提供商" />
                  <SegmentedControlItem value="false" label="关闭" />
                  <SegmentedControlItem value="true" label="开启" />
                </SegmentedControl>
                <VStack gap={2}>
                  <Text>输入模态</Text>
                  <FormLayout direction="horizontal">
                    {["text", "image"].map((modality) => (
                      <CheckboxInput
                        key={modality}
                        label={modality}
                        value={form.input_modalities.includes(modality)}
                        onChange={() => toggleList("input_modalities", modality)}
                      />
                    ))}
                  </FormLayout>
                </VStack>
                <Text weight="semibold">计价</Text>
                <FormLayout direction="horizontal">
                  <NumberInput
                    label="普通输入"
                    value={form.input}
                    onChange={(value) => patchForm("input", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="缓存读取"
                    value={form.cached}
                    onChange={(value) => patchForm("cached", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="缓存写入"
                    value={form.cacheWrite}
                    onChange={(value) => patchForm("cacheWrite", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                </FormLayout>
                <FormLayout direction="horizontal">
                  <NumberInput
                    label="输出"
                    value={form.output}
                    onChange={(value) => patchForm("output", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="推理"
                    value={form.reasoning}
                    onChange={(value) => patchForm("reasoning", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="整体倍率"
                    value={form.multiplier}
                    onChange={(value) => patchForm("multiplier", value ?? 1)}
                    min={0}
                    step={0.01}
                    isRequired
                  />
                </FormLayout>
                <FormLayout direction="horizontal">
                  <NumberInput
                    label="图片输入"
                    value={form.imageInput}
                    onChange={(value) => patchForm("imageInput", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="图片缓存读取"
                    value={form.cachedImageInput}
                    onChange={(value) =>
                      patchForm("cachedImageInput", value ?? 0)
                    }
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                  <NumberInput
                    label="图片输出"
                    value={form.imageOutput}
                    onChange={(value) => patchForm("imageOutput", value ?? 0)}
                    min={0}
                    step={0.0001}
                    isRequired
                  />
                </FormLayout>
              </FormLayout>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2} wrap="wrap">
                {editingPrice?.capability_source === "admin" ? (
                  <Button
                    label="清除能力覆盖"
                    onClick={() => void removeCapability(editingPrice.model)}
                  />
                ) : null}
                <Button
                  label="取消"
                  onClick={() => setEditingPrice(null)}
                />
                <Button
                  label="保存"
                  variant="primary"
                  icon={<CircleDollarSignIcon />}
                  isLoading={pending}
                  onClick={() => void savePrice()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  )
}

function millionFromNano(value: number) {
  return Number((value / 1000).toFixed(4))
}

function nanoFromMillion(value: number) {
  return Math.round(Number(value || 0) * 1000)
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
