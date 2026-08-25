import { Button } from "@astryxdesign/core/Button"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Center } from "@astryxdesign/core/Center"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

export function LoadErrorView({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Center minHeight={320}>
      <EmptyState
        title="页面数据加载失败"
        description={message}
        icon={<TriangleAlertIcon />}
        actions={
          <Button
            label="重试"
            variant="primary"
            icon={<RefreshCwIcon />}
            onClick={onRetry}
          />
        }
      />
    </Center>
  )
}
