import rai from "@/content/releases/2026-10-21-rai.md?raw"
import cursor from "@/content/releases/2026-10-18-cursor.md?raw"
import billing from "@/content/releases/2026-10-17-billing.md?raw"

export interface Release {
  id: string
  date: string
  category: string
  title: string
  summary: string
  body: string
}

// Newest first. IDs are permanent: links and read receipts both use them.
export const releases: Release[] = [
  {
    id: "2026-10-21-rai",
    date: "2026-10-21",
    category: "功能更新",
    title: "在终端，完成更多日常操作",
    summary: "rai 统一认证入口，新增密钥、用量与设备管理命令。",
    body: rai,
  },
  {
    id: "2026-10-18-cursor",
    date: "2026-10-18",
    category: "模型接入",
    title: "Cursor 模型，现在接入 RelayAPI",
    summary: "添加 Cursor API Key，使用现有 Relay 密钥访问可用模型。",
    body: cursor,
  },
  {
    id: "2026-10-17-billing",
    date: "2026-10-17",
    category: "体验改进",
    title: "每一笔费用，都有清楚的明细",
    summary: "按实际生成结果记录扣费，缺少可靠用量或价格时不再估算。",
    body: billing,
  },
]

export function releaseDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T00:00:00+08:00`))
}
