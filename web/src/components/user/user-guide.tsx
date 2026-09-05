import { lazy } from "react"

import { PageHeader } from "@/components/workspace-ui"

const ConnectionGuide = lazy(() =>
  import("@/components/connection-guide").then((module) => ({
    default: module.ConnectionGuide,
  }))
)

export function UserGuide() {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="接入指南"
        description="选择客户端并复制配置，使用 API Key 调用已授权模型。"
      />
      <ConnectionGuide />
    </div>
  )
}
