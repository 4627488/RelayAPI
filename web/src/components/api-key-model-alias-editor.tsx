import { Button } from "@astryxdesign/core/Button"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { Selector } from "@astryxdesign/core/Selector"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { PlusIcon, Trash2Icon } from "lucide-react"

import type { ApiKeyModelAlias } from "@/lib/api"

export type ModelAliasDraft = ApiKeyModelAlias & { clientId: string }

export interface ModelAliasPreset {
  label: string
  aliases: string[]
  target: string
}

const CODEX_ALIASES = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6"]

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
  const grokTarget =
    availableModels.find((model) => model.toLowerCase().includes("grok")) ?? ""
  const preset: ModelAliasPreset | null = grokTarget
    ? { label: "Codex → Grok", aliases: CODEX_ALIASES, target: grokTarget }
    : null

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Text weight="semibold">模型别名</Text>
        <Text color="secondary">
          客户端请求别名时，会路由到选定的实际模型。
        </Text>
      </VStack>
      {preset ? (
        <Button
          label="Codex → Grok"
          variant="secondary"
          size="sm"
          onClick={() => onApplyPreset(preset)}
        />
      ) : (
        <Text color="secondary">当前账户未提供 Grok，预设不可用。</Text>
      )}
      {aliases.map((item, index) => (
        <HStack key={item.clientId} gap={2} vAlign="end">
          <TextInput
            label="别名"
            value={item.alias}
            placeholder="例如 fast"
            onChange={(alias) =>
              onChange(
                aliases.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, alias } : row
                )
              )
            }
          />
          <Selector
            label="目标模型"
            value={item.model}
            options={models.length ? models : availableModels}
            onChange={(model) =>
              onChange(
                aliases.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, model } : row
                )
              )
            }
          />
          <Button
            label="删除别名"
            variant="ghost"
            isIconOnly
            icon={<Trash2Icon />}
            onClick={() =>
              onChange(aliases.filter((row) => row.clientId !== item.clientId))
            }
          />
        </HStack>
      ))}
      <FormLayout>
        <Button
          label="添加别名"
          variant="secondary"
          icon={<PlusIcon />}
          onClick={() =>
            onChange([
              ...aliases,
              {
                clientId: crypto.randomUUID(),
                alias: "",
                model: models[0] ?? availableModels[0] ?? "",
              },
            ])
          }
        />
      </FormLayout>
    </VStack>
  )
}
