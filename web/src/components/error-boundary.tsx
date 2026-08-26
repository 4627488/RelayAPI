import { Component, type ErrorInfo, type ReactNode } from "react"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

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
            <div className="flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <CardTitle>控制台遇到运行时错误</CardTitle>
            <CardDescription>
              页面没有继续白屏。请刷新重试；若问题持续存在，请提供下方错误信息。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
              {this.state.error.message || "未知错误"}
            </pre>
            <Button onClick={() => window.location.reload()}>
              <RefreshCwIcon data-icon="inline-start" />
              刷新页面
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }
}
