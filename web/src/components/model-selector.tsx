import { MultiSelector } from "@astryxdesign/core/MultiSelector"
import { Text } from "@astryxdesign/core/Text"

type Props = {
  id?: string
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
  allLabel?: string
}

export function ModelSelector({
  options,
  value,
  onChange,
  allLabel = "全部可用模型",
}: Props) {
  if (!options.length) {
    return (
      <Text color="secondary">
        这个账户没有可枚举的模型列表；当前将继承账户全部模型。
      </Text>
    )
  }

  return (
    <MultiSelector
      label="模型范围"
      options={options}
      value={value}
      onChange={onChange}
      placeholder={allLabel}
      hasSearch={options.length > 8}
      searchPlaceholder="筛选模型"
      hasClear
      triggerDisplay="count"
      formatValue={(items) =>
        items.length ? `已选 ${items.length}` : allLabel
      }
      description="不选择表示允许全部可用模型。新建时默认全选当前可用模型。"
      width="100%"
    />
  )
}
