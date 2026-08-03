import { PlusIcon, Trash2Icon } from "lucide-react"

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

export function ApiKeyModelAliasEditor({
  aliases,
  models,
  onChange,
}: {
  aliases: ModelAliasDraft[]
  models: string[]
  onChange: (aliases: ModelAliasDraft[]) => void
}) {
  function update(clientId: string, field: "alias" | "model", value: string) {
    onChange(aliases.map((item) => item.clientId === clientId ? { ...item, [field]: value } : item))
  }

  return (
    <FieldSet>
      <FieldLegend>模型别名</FieldLegend>
      <FieldDescription>客户端可使用别名请求；权限、计费和上游路由仍按目标模型处理。</FieldDescription>
      <FieldGroup className="gap-2">
        {aliases.map((item, index) => {
          const options = Array.from(new Set([...models, item.model].filter(Boolean))).sort()
          return (
            <Field key={item.clientId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
              <FieldLabel htmlFor={`model-alias-${item.clientId}`} className="sr-only">第 {index + 1} 个模型别名</FieldLabel>
              <Input
                id={`model-alias-${item.clientId}`}
                value={item.alias}
                onChange={(event) => update(item.clientId, "alias", event.target.value)}
                placeholder="别名，例如 fast"
                required
              />
              <Select value={item.model || null} onValueChange={(value) => update(item.clientId, "model", value ?? "")} required>
                <SelectTrigger className="w-full"><SelectValue placeholder="目标模型" /></SelectTrigger>
                <SelectContent><SelectGroup>{options.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除第 ${index + 1} 个模型别名`} onClick={() => onChange(aliases.filter((alias) => alias.clientId !== item.clientId))}>
                <Trash2Icon />
              </Button>
            </Field>
          )
        })}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...aliases, { clientId: crypto.randomUUID(), alias: "", model: "" }])}>
          <PlusIcon data-icon="inline-start" />添加别名
        </Button>
      </FieldGroup>
    </FieldSet>
  )
}
