import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function LoadErrorView({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <div className="flex size-10 items-center justify-center bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="size-5" />
        </div>
        <CardTitle>页面数据加载失败</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" />
          重试
        </Button>
      </CardContent>
    </Card>
  )
}
