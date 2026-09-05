import { Component, type ErrorInfo, type ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { RefreshCwIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

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
      <main className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>
              <h1>页面暂时无法显示</h1>
            </CardTitle>
            <CardDescription>
              请刷新重试；若问题持续存在，请提供下方错误信息。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <pre className="max-h-40 overflow-auto text-sm whitespace-pre-wrap">
              {this.state.error.message || "未知错误"}
            </pre>
            <Button onClick={() => window.location.reload()}>
              <HugeiconsIcon
                strokeWidth={2}
                icon={RefreshCwIcon}
                data-icon="inline-start"
              />
              刷新页面
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }
}
