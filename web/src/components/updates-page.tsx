import { useEffect } from "react"
import { CheckIcon, CheckCheckIcon } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useReleaseInbox } from "@/hooks/use-release-inbox"
import { releaseDate, releases } from "@/lib/releases"
import { navigateTo, routeHref, type Workspace } from "@/lib/routes"

export function UpdatesPage({
  accountId,
  workspace,
  releaseId,
}: {
  accountId: string
  workspace: Workspace
  releaseId?: string
}) {
  const { readIds, markRead } = useReleaseInbox(accountId)
  const unread = releases.filter((release) => !readIds.has(release.id)).length
  const unknownRelease =
    releaseId && !releases.some((release) => release.id === releaseId)

  useEffect(() => {
    if (!releaseId) return
    const heading = document.getElementById(`release-${releaseId}`)
    heading?.scrollIntoView({ block: "start" })
    heading?.focus({ preventScroll: true })
    if (releases.some((release) => release.id === releaseId))
      markRead([releaseId])
  }, [releaseId, markRead])

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 py-4 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex max-w-xl flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            近期更新
          </h1>
          <p className="text-sm leading-7 text-muted-foreground md:text-base">
            RelayAPI
            的新功能、细节改进与使用提示。每一次变化，都在这里留下记录。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unread === 0}
          onClick={() => markRead(releases.map((release) => release.id))}
        >
          <CheckCheckIcon data-icon="inline-start" />
          {unread ? "全部标为已读" : "已读完所有更新"}
        </Button>
      </header>
      <Separator />
      {unknownRelease ? (
        <p role="status" className="text-sm text-muted-foreground">
          这篇更新暂未收录，你可以先浏览下方的近期发行说明。
        </p>
      ) : null}
      <div className="grid min-w-0 gap-12 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-16">
        <aside>
          <nav
            aria-label="更新目录"
            className="grid grid-cols-3 gap-4 lg:sticky lg:top-24 lg:flex lg:flex-col"
          >
            <p className="col-span-3 text-xs font-medium text-muted-foreground">
              发行记录
            </p>
            {releases.map((release) => (
              <a
                key={release.id}
                href={routeHref({
                  workspace,
                  page: "updates",
                  releaseId: release.id,
                })}
                aria-current={releaseId === release.id ? "location" : undefined}
                className="flex flex-col gap-1 text-sm leading-6 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-current:text-foreground"
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return
                  event.preventDefault()
                  markRead([release.id])
                  navigateTo({
                    workspace,
                    page: "updates",
                    releaseId: release.id,
                  })
                  if (releaseId === release.id)
                    document
                      .getElementById(`release-${release.id}`)
                      ?.scrollIntoView({ block: "start" })
                }}
              >
                <time dateTime={release.date} className="text-xs tabular-nums">
                  {release.date.slice(5).replace("-", "/")}
                </time>
                <span className="line-clamp-2 lg:line-clamp-none">
                  {release.title}
                </span>
              </a>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-col gap-12">
          {releases.map((release, index) => (
            <article
              key={release.id}
              aria-labelledby={`release-${release.id}`}
              className="min-w-0"
            >
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <time
                  dateTime={release.date}
                  className="text-sm text-muted-foreground"
                >
                  {releaseDate(release.date)}
                </time>
                <Badge variant="outline">{release.category}</Badge>
                {index === 0 ? <Badge variant="secondary">最新</Badge> : null}
              </div>
              <h2
                id={`release-${release.id}`}
                tabIndex={-1}
                className="mb-6 scroll-mt-24 text-2xl font-semibold tracking-tight outline-none md:text-3xl"
              >
                {release.title}
              </h2>
              <div className="release-markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: ({ children }) => (
                      <pre tabIndex={0} role="region" aria-label="代码示例">
                        {children}
                      </pre>
                    ),
                    table: ({ children, ...props }) => (
                      <div
                        className="overflow-x-auto"
                        tabIndex={0}
                        role="region"
                        aria-label="更新说明表格"
                      >
                        <table {...props}>{children}</table>
                      </div>
                    ),
                    hr: () => <Separator />,
                  }}
                >
                  {release.body}
                </Markdown>
              </div>
              <div className="mt-6">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readIds.has(release.id)}
                  onClick={() => markRead([release.id])}
                >
                  <CheckIcon data-icon="inline-start" />
                  {readIds.has(release.id) ? "已读" : "标为已读"}
                </Button>
              </div>
              {index < releases.length - 1 ? (
                <Separator className="mt-10" />
              ) : null}
            </article>
          ))}
          <p className="text-sm text-muted-foreground">
            以上是近期的更新记录。更多改进，陆续与你见面。
          </p>
        </div>
      </div>
    </div>
  )
}
