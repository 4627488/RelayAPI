import { useCallback, useState } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  postJSON,
  type CatalogSyncPreview,
  type ModelAlias,
  type ModelPrice,
  type ModelPriceRule,
} from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function AdminPricingPage() {
  const load = useCallback(async () => {
    const [prices, aliases, rules] = await Promise.all([
      api<{ available_models: ModelPrice[]; available_models_error?: string }>(
        "/api/admin/prices"
      ),
      api<{ items: ModelAlias[] }>("/api/admin/pricing/aliases"),
      api<{ items: ModelPriceRule[]; fields: string[] }>(
        "/api/admin/pricing/rules"
      ),
    ])
    return {
      models: prices.available_models ?? [],
      modelsError: prices.available_models_error ?? "",
      aliases: aliases.items ?? [],
      rules: rules.items ?? [],
      fields: rules.fields ?? [],
    }
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: {
      models: [] as ModelPrice[],
      modelsError: "",
      aliases: [] as ModelAlias[],
      rules: [] as ModelPriceRule[],
      fields: [] as string[],
    },
    errorMessage: "无法读取价格目录",
    onBackgroundError: (message) => toast.error(message),
  })
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<CatalogSyncPreview | null>(null)

  async function previewSync() {
    setPending(true)
    try {
      setPreview(await api<CatalogSyncPreview>("/api/admin/pricing/sync"))
    } catch (cause) {
      toast.error(errorMessage(cause, "预览失败"))
    } finally {
      setPending(false)
    }
  }

  async function applySync() {
    setPending(true)
    try {
      await postJSON("/api/admin/pricing/sync", {})
      toast.success("已应用 Models.dev 目录")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "同步失败"))
    } finally {
      setPending(false)
    }
  }

  async function saveAliases() {
    const alias = (document.getElementById("alias-name") as HTMLInputElement)
      ?.value
    const model = (document.getElementById("alias-model") as HTMLInputElement)
      ?.value
    if (!alias || !model) {
      toast.error("别名和目标模型必填")
      return
    }
    setPending(true)
    try {
      await api("/api/admin/pricing/aliases", {
        method: "PUT",
        body: JSON.stringify({
          items: [...data.aliases, { alias, model }],
        }),
      })
      toast.success("别名已保存")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "保存失败"))
    } finally {
      setPending(false)
    }
  }

  if (loading) return <LoadingState />
  if (error && data.models.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page
      title="目录与计费"
      description="可用模型价格、全局别名和倍率规则。"
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => void previewSync()}
          >
            预览目录
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() => void applySync()}
          >
            应用 Models.dev
          </Button>
        </div>
      }
    >
      {data.modelsError ? <ErrorState message={data.modelsError} /> : null}
      {preview ? (
        <Surface title="目录预览">
          <p className="text-sm text-kumo-subtle">
            {preview.source} · {preview.version}
          </p>
        </Surface>
      ) : null}
      <Surface title="可用模型">
        <DataTable
          columns={["模型", "输入", "输出", "来源"]}
          empty={<EmptyState title="没有可用模型" />}
          rows={data.models.map((item) => (
            <tr
              key={item.model}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">{item.display_name || item.model}</td>
              <td className="px-3 py-2 tabular-nums">
                {item.input_nano_usd_per_token}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {item.output_nano_usd_per_token}
              </td>
              <td className="px-3 py-2 text-kumo-subtle">{item.source}</td>
            </tr>
          ))}
        />
      </Surface>
      <Surface title="模型别名">
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            id="alias-name"
            placeholder="别名，例如 fast"
            className="max-w-40"
          />
          <Input id="alias-model" placeholder="目标模型" className="max-w-48" />
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => void saveAliases()}
          >
            添加
          </Button>
        </div>
        <DataTable
          columns={["别名", "目标"]}
          empty={<EmptyState title="没有全局别名" />}
          rows={data.aliases.map((item) => (
            <tr
              key={item.alias}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2 font-mono text-[0.9em]">{item.alias}</td>
              <td className="px-3 py-2">{item.model}</td>
            </tr>
          ))}
        />
      </Surface>
      <Surface title="倍率规则">
        <DataTable
          columns={["模型", "字段", "值", "倍率"]}
          empty={<EmptyState title="没有倍率规则" />}
          rows={data.rules.map((item) => (
            <tr
              key={`${item.model}-${item.field}-${item.value}`}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">{item.model}</td>
              <td className="px-3 py-2">{item.field}</td>
              <td className="px-3 py-2">{item.value}</td>
              <td className="px-3 py-2 tabular-nums">{item.multiplier}</td>
            </tr>
          ))}
        />
      </Surface>
    </Page>
  )
}
