import { HugeiconsIcon } from "@hugeicons/react"
import {
  PlusIcon,
  Delete02Icon,
  WandSparklesIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ApiKeyModelAlias } from "@/lib/api"

export type ModelAliasDraft = ApiKeyModelAlias & { clientId: string }

export interface ModelAliasPreset {
  id: string
  label: string
  description: string
  aliases: string[]
  target: string
}

const grokTargetNames = ["grok-4.6", "xai/grok-4.6", "grok-4.5", "xai/grok-4.5"]

const clientPresets = [
  {
    id: "codex-grok-latest",
    label: "Codex → Grok",
    description: "将 Codex 当前 GPT-5.6 模型入口统一路由到最新可用 Grok。",
    aliases: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6"],
  },
] as const

function grokTarget(models: string[]) {
  return grokTargetNames.flatMap((name) =>
    models.filter((model) => model === name || model.endsWith(`/${name}`))
  )[0]
}

export function ApiKeyModelAliasEditor({
  aliases,
  models,
  availableModels,
  onChange,
  onApplyPreset,
}: {
  aliases: ModelAliasDraft[]
  models: string[]
  availableModels: string[]
  onChange: (aliases: ModelAliasDraft[]) => void
  onApplyPreset: (preset: ModelAliasPreset) => void
}) {
  function update(clientId: string, field: "alias" | "model", value: string) {
    onChange(
      aliases.map((item) =>
        item.clientId === clientId ? { ...item, [field]: value } : item
      )
    )
  }

  const target = grokTarget(availableModels)

  return (
    <FieldSet>
      <FieldLegend>模型别名</FieldLegend>
      <FieldDescription>
        客户端可使用别名请求；权限、计费和上游路由仍按目标模型处理。
      </FieldDescription>
      <FieldGroup className="gap-2">
        <div className="grid gap-2 sm:grid-cols-2">
          {clientPresets.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              size="lg"
              className="items-start justify-start text-left whitespace-normal"
              disabled={!target}
              title={
                target ? preset.description : "当前账户没有可用的 Grok 模型"
              }
              onClick={() =>
                target &&
                onApplyPreset({
                  ...preset,
                  aliases: [...preset.aliases],
                  target,
                })
              }
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={WandSparklesIcon}
                data-icon="inline-start"
              />
              <span className="flex flex-col gap-1">
                <span>{preset.label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {preset.description}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <FieldDescription>
          应用预设会启用目标模型、移除同名直连模型，并保留其他手工别名。
          {target
            ? ` 当前目标：${target}`
            : " 当前账户未提供 Grok，预设不可用。"}
        </FieldDescription>
        {aliases.map((item, index) => {
          const options = Array.from(
            new Set([...models, item.model].filter(Boolean))
          ).sort()
          return (
            <Field
              key={item.clientId}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
            >
              <FieldLabel
                htmlFor={`model-alias-${item.clientId}`}
                className="sr-only"
              >
                第 {index + 1} 个模型别名
              </FieldLabel>
              <Input
                id={`model-alias-${item.clientId}`}
                value={item.alias}
                onChange={(event) =>
                  update(item.clientId, "alias", event.target.value)
                }
                placeholder="别名，例如 fast"
                required
              />
              <Select
                items={options.map((model) => ({ value: model, label: model }))}
                value={item.model || null}
                onValueChange={(value) =>
                  update(item.clientId, "model", value ?? "")
                }
                required
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="目标模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`删除第 ${index + 1} 个模型别名`}
                onClick={() =>
                  onChange(
                    aliases.filter((alias) => alias.clientId !== item.clientId)
                  )
                }
              >
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
              </Button>
            </Field>
          )
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange([
              ...aliases,
              { clientId: crypto.randomUUID(), alias: "", model: "" },
            ])
          }
        >
          <HugeiconsIcon
            strokeWidth={2}
            icon={PlusIcon}
            data-icon="inline-start"
          />
          添加别名
        </Button>
      </FieldGroup>
    </FieldSet>
  )
}
