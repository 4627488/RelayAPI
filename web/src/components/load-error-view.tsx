import { Button } from "@astryxdesign/core/Button"
import { Center } from "@astryxdesign/core/Center"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Layout, LayoutContent } from "@astryxdesign/core/Layout"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

export function LoadErrorView({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Layout height="fill">
      <LayoutContent padding={6}>
        <Center minHeight="100%">
          <EmptyState
            title="无法读取这一页"
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
      </LayoutContent>
    </Layout>
  )
}
