import { useMemo, useState } from "react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item"
import { toast } from "@/components/ui/toast"

type Props = {
  id: string
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
  allLabel?: string
}

const ALL_VALUE_PREFIX = "__all_available_models__"

export function ModelSelector({
  id,
  options,
  value,
  onChange,
  allLabel = "全部可用模型",
}: Props) {
  const [open, setOpen] = useState(false)
  const models = useMemo(
    () =>
      Array.from(
        new Set(
          [...value, ...options].map((item) => item.trim()).filter(Boolean)
        )
      ).sort(),
    [options, value]
  )
  let ALL_VALUE = ALL_VALUE_PREFIX
  while (models.includes(ALL_VALUE)) ALL_VALUE += "_"
  const comboValue = value.length ? value : [ALL_VALUE]
  const items = [ALL_VALUE, ...models]

  return (
    <div id={id} className="flex flex-col gap-2">
      <Combobox
        multiple
        items={items}
        itemToStringLabel={(item) =>
          item === ALL_VALUE ? allLabel : String(item)
        }
        value={comboValue}
        onValueChange={(next) => {
          const nextValues = next as string[]
          if (!nextValues.length && value.length > 0) {
            toast.add({
              title: "请先选择“全部可用模型”以继承权限",
              type: "error",
            })
            return
          }
          if (nextValues.includes(ALL_VALUE)) {
            onChange(
              value.length
                ? []
                : nextValues.filter((item) => item !== ALL_VALUE)
            )
            return
          }
          onChange(nextValues)
        }}
        open={open}
        onOpenChange={setOpen}
      >
        <ComboboxInput
          aria-label={allLabel}
          placeholder={
            value.length ? `已选择 ${value.length} 个模型` : allLabel
          }
          showClear
        />
        <ComboboxContent>
          <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
          <ComboboxList>
            {(item: (typeof items)[number]) => (
              <ComboboxItem
                key={item}
                value={item}
                title={item === ALL_VALUE ? allLabel : item}
              >
                {item === ALL_VALUE ? allLabel : item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <Item variant="muted" size="xs">
        <ItemContent>
          <ItemTitle>
            {value.length ? `已选择 ${value.length} 个模型` : allLabel}
          </ItemTitle>
          <ItemDescription>
            {value.length
              ? value.join(", ")
              : "继承账户允许的全部模型；选择具体模型可缩小范围。"}
          </ItemDescription>
        </ItemContent>
      </Item>
    </div>
  )
}
