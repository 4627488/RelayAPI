import { useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Tick02Icon, Search01Icon } from "@hugeicons/core-free-icons"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Props = {
  id: string
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
  allLabel?: string
}

export function ModelSelector({
  id,
  options,
  value,
  onChange,
  allLabel = "全部可用模型",
}: Props) {
  const [query, setQuery] = useState("")
  const models = useMemo(
    () =>
      Array.from(
        new Set(
          [...value, ...options].map((item) => item.trim()).filter(Boolean)
        )
      ).sort(),
    [options, value]
  )
  const filtered = models.filter((model) =>
    model.toLowerCase().includes(query.trim().toLowerCase())
  )
  const selected = new Set(value)

  function toggle(model: string) {
    onChange(
      selected.has(model)
        ? value.filter((item) => item !== model)
        : [...value, model]
    )
  }

  return (
    <div id={id} className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant={!value.length ? "secondary" : "outline"}
          onClick={() => onChange([])}
        >
          {!value.length ? (
            <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
          ) : null}
          {allLabel}
        </Button>
        <Badge variant="outline">
          {value.length ? `已选 ${value.length}` : `共 ${options.length} 个`}
        </Badge>
      </div>
      {models.length > 8 ? (
        <div className="relative">
          <HugeiconsIcon
            strokeWidth={2}
            icon={Search01Icon}
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选模型"
            className="pl-8"
          />
        </div>
      ) : null}
      {models.length ? (
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {filtered.map((model) => (
            <Button
              key={model}
              type="button"
              size="sm"
              variant={selected.has(model) ? "secondary" : "ghost"}
              className="max-w-full"
              onClick={() => toggle(model)}
              title={model}
            >
              {selected.has(model) ? (
                <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
              ) : null}
              <span className="truncate">{model}</span>
            </Button>
          ))}
          {!filtered.length ? (
            <p className="py-3 text-sm text-muted-foreground">没有匹配的模型</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          这个账户没有可枚举的模型列表；当前将继承账户全部模型。
        </p>
      )}
    </div>
  )
}
