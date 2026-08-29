import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("RelayAPI UI crashed", error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <LayerCard className="w-full max-w-md p-5">
          <h1 className="text-base font-semibold">控制台无法继续</h1>
          <p className="mt-2 text-sm text-kumo-subtle">
            {this.state.error.message || "发生了未处理的错误。"}
          </p>
          <Button
            className="mt-4"
            variant="primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </Button>
        </LayerCard>
      </main>
    )
  }
}
