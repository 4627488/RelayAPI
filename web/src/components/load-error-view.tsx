import { HugeiconsIcon } from "@hugeicons/react"
import { RefreshCwIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons"

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function LoadErrorView({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Alert className="mx-auto w-full max-w-xl" variant="destructive">
      <HugeiconsIcon strokeWidth={2} icon={TriangleAlertIcon} />
      <AlertTitle>页面数据加载失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button onClick={onRetry} size="sm" variant="outline">
          <HugeiconsIcon
            strokeWidth={2}
            icon={RefreshCwIcon}
            data-icon="inline-start"
          />
          重试
        </Button>
      </AlertAction>
    </Alert>
  )
}
