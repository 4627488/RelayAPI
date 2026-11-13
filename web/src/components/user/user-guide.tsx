import { lazy } from "react"

import { PageHeader } from "@/components/workspace-ui"
import { Button } from "@/components/ui/button"

const ConnectionGuide = lazy(() =>
  import("@/components/connection-guide").then((module) => ({
    default: module.ConnectionGuide,
  }))
)

export function UserGuide() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="接入指南"
        actions={
          <Button nativeButton={false} render={<a href="/rai/authorize" />}>
            设备验证码登录
          </Button>
        }
      />
      <ConnectionGuide />
    </div>
  )
}
