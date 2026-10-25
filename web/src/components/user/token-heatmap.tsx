import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react"
import { CopyIcon, DownloadIcon, LinkIcon, RotateCwIcon } from "lucide-react"
import { api } from "@/lib/api"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

export interface HeatmapDay {
  date: string
  tokens: number
  model: string
  level: number
  color: string
}
export interface TokenHeatmapReport {
  start: string
  end: string
  timezone: string
  total_tokens: number
  active_days: number
  peak_tokens: number
  days: HeatmapDay[]
  models: { name: string; tokens: number; color: string }[]
  share_path: string
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const exact = new Intl.NumberFormat("zh-CN")
const intensity = [0, 0.28, 0.48, 0.72, 1]

function describe(day: HeatmapDay) {
  return `${day.date} · ${exact.format(day.tokens)} tokens${day.model ? ` · 最常用 ${day.model}` : " · 暂无消耗"}`
}

export function TokenCalendar({ report }: { report: TokenHeatmapReport }) {
  const [active, setActive] = useState(report.days.length - 1)
  const [inspected, setInspected] = useState<number | null>(null)
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const scroll = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth
  }, [report.end])
  const offset = new Date(`${report.start}T00:00:00Z`).getUTCDay()
  const columns = Math.ceil((offset + report.days.length) / 7)
  const months = report.days.flatMap((day, i) => {
    const date = new Date(`${day.date}T00:00:00Z`)
    if (date.getUTCDate() !== 1 && (i !== 0 || date.getUTCDate() > 21))
      return []
    return [
      {
        label: `${date.getUTCMonth() + 1}月`,
        column: Math.floor((i + offset) / 7) + 1,
      },
    ]
  })
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    }
    let next = index
    if (event.key in delta) next += delta[event.key]
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = report.days.length - 1
    else return
    event.preventDefault()
    next = Math.min(report.days.length - 1, Math.max(0, next))
    setActive(next)
    cells.current[next]?.focus()
  }
  const selected = inspected === null ? null : report.days[inspected]
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        ref={scroll}
        className="overflow-x-auto pb-1"
        aria-label="每日 token 消耗日历"
      >
        <div
          className="heatmap-calendar"
          style={{ "--heatmap-columns": columns } as CSSProperties}
        >
          <div
            className="heatmap-months text-xs text-muted-foreground"
            aria-hidden="true"
          >
            {months.map((month, i) => (
              <span key={i} style={{ gridColumn: month.column }}>
                {month.label}
              </span>
            ))}
          </div>
          <div
            className="heatmap-weekdays text-xs text-muted-foreground"
            aria-hidden="true"
          >
            <span style={{ gridRow: 2 }}>一</span>
            <span style={{ gridRow: 4 }}>三</span>
            <span style={{ gridRow: 6 }}>五</span>
          </div>
          <div className="heatmap-days" onMouseLeave={() => setInspected(null)}>
            {report.days.map((day, index) => (
              <button
                key={day.date}
                type="button"
                ref={(element) => {
                  cells.current[index] = element
                }}
                className="heatmap-day"
                style={{
                  gridColumn: Math.floor((offset + index) / 7) + 1,
                  gridRow: ((offset + index) % 7) + 1,
                }}
                aria-label={describe(day)}
                title={describe(day)}
                tabIndex={active === index ? 0 : -1}
                onFocus={() => {
                  setActive(index)
                  setInspected(index)
                }}
                onMouseEnter={() => setInspected(index)}
                onClick={() => setInspected(index)}
                onKeyDown={(event) => navigate(event, index)}
              >
                {day.level > 0 && (
                  <span
                    aria-hidden="true"
                    style={{
                      backgroundColor: day.color,
                      opacity: intensity[day.level],
                    }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p className="min-h-4" aria-live="polite">
          {selected
            ? describe(selected)
            : report.active_days
              ? "悬停或点选查看每日消耗，也可用方向键浏览。"
              : "还没有 token 消耗，开始使用模型后会在这里留下记录。"}
        </p>
        <div
          className="flex shrink-0 items-center gap-1.5"
          aria-label="颜色越深，当日 token 消耗越多"
        >
          <span className="mr-1">少</span>
          {intensity.map((opacity, i) => (
            <span key={i} className="heatmap-legend-cell">
              <span
                style={{
                  backgroundColor: report.models[0]?.color ?? "#1b9e77",
                  opacity,
                }}
              />
            </span>
          ))}
          <span className="ml-1">多</span>
        </div>
      </div>
      {report.models.length > 0 && (
        <ul
          className="flex flex-wrap gap-x-5 gap-y-2"
          aria-label="模型颜色图例"
        >
          {report.models.map((model) => (
            <li
              key={model.name}
              className="flex min-w-0 items-center gap-2 text-xs"
            >
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: model.color }}
                aria-hidden="true"
              />
              <span className="max-w-52 truncate" title={model.name}>
                {model.name === "Other models" ? "其他模型" : model.name}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {compact.format(model.tokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function TokenHeatmap() {
  const load = useCallback(
    () => api<TokenHeatmapReport>("/api/usage/heatmap"),
    []
  )
  const { data, error, loading, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取 token 消耗",
  })
  const [sharePath, setSharePath] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState("")
  const [message, setMessage] = useState("")
  const path = sharePath ?? data?.share_path ?? ""
  const url = path ? new URL(path, window.location.origin).href : ""
  async function share(method: "POST" | "DELETE") {
    if (pending) return
    setPending(true)
    setActionError("")
    setMessage("")
    try {
      const response = await api<{ share_path: string } | undefined>(
        "/api/usage/heatmap/share",
        { method }
      )
      setSharePath(response?.share_path ?? "")
      setMessage(
        method === "DELETE"
          ? "公开分享已关闭，原链接已失效。"
          : path
            ? "链接已重置，原链接已失效。"
            : "公开分享已开启。"
      )
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "分享设置保存失败"
      )
    } finally {
      setPending(false)
    }
  }
  async function copy(markdown: boolean) {
    setActionError("")
    try {
      await navigator.clipboard.writeText(
        markdown ? `![Token activity](${url})` : url
      )
      setMessage(markdown ? "Markdown 已复制。" : "SVG 链接已复制。")
    } catch {
      setActionError("复制失败，请手动复制下方链接。")
    }
  }
  return (
    <Card className="min-w-0" aria-label="Token 消耗热力图" aria-busy={loading}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Token 消耗</CardTitle>
            <CardDescription>过去一年 · 所有模型 · UTC 日历</CardDescription>
          </div>
          {data && (
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-semibold tracking-tight tabular-nums"
                title={`${exact.format(data.total_tokens)} tokens`}
              >
                {compact.format(data.total_tokens)}
              </span>
              <span className="text-xs text-muted-foreground">
                tokens / {data.active_days} 个活跃日
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reload(true)}
              >
                重试
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!data && loading && <Skeleton className="h-44 w-full" />}
        {data && <TokenCalendar report={data} />}
        <p className="text-xs text-muted-foreground">
          颜色代表当天 token 用量最高的模型，深浅按活跃日用量分级。缓存与推理
          token 不重复累加。
        </p>
      </CardContent>
      {data && (
        <CardFooter className="flex-col items-stretch gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs text-muted-foreground">
              {path
                ? "持有链接的人可查看每日消耗和模型。链接与 API Key 无关，可随时关闭或重置。"
                : "公开分享默认关闭。开启后仅公开每日消耗和模型，不公开身份、API Key 或请求内容。"}
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <a
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href="/api/usage/heatmap.svg"
                download="token-heatmap.svg"
              >
                <DownloadIcon data-icon="inline-start" />
                下载 SVG
              </a>
              {!path ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void share("POST")}
                >
                  <LinkIcon data-icon="inline-start" />
                  开启公开分享
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void share("DELETE")}
                >
                  关闭分享
                </Button>
              )}
            </div>
          </div>
          {path && (
            <>
              <Field>
                <FieldLabel htmlFor="heatmap-share-url">
                  公开 SVG 链接
                </FieldLabel>
                <Input
                  id="heatmap-share-url"
                  value={url}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(false)}
                >
                  <CopyIcon data-icon="inline-start" />
                  复制链接
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(true)}
                >
                  复制 Markdown
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => void share("POST")}
                >
                  <RotateCwIcon data-icon="inline-start" />
                  重置链接
                </Button>
                <p className="self-center text-xs text-muted-foreground">
                  支持 ?theme=light / dark / auto
                </p>
              </div>
            </>
          )}
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {message && (
            <p role="status" className="text-xs text-muted-foreground">
              {message}
            </p>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
