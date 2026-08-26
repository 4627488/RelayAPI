import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@astryxdesign/core/Button"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Center } from "@astryxdesign/core/Center"
import { Text } from "@astryxdesign/core/Text"
import { VStack } from "@astryxdesign/core/Layout"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("RelayAPI UI crashed", error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <Center minHeight="100dvh" padding={6}>
        <VStack gap={4} width={480}>
          <EmptyState
            title="控制台遇到运行时错误"
            description="页面没有继续白屏。请刷新重试；若问题持续存在，请提供下方错误信息。"
            icon={<TriangleAlertIcon />}
            headingLevel={1}
            actions={
              <Button
                label="刷新页面"
                variant="primary"
                icon={<RefreshCwIcon />}
                onClick={() => window.location.reload()}
              />
            }
          />
          <Text type="code">{this.state.error.message || "未知错误"}</Text>
        </VStack>
      </Center>
    )
  }
}
