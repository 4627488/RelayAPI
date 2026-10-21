import { useState } from "react"
import { ArrowRightIcon, CheckCheckIcon, MailIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useReleaseInbox } from "@/hooks/use-release-inbox"
import { releases, releaseDate } from "@/lib/releases"
import { navigateTo, routeHref, type Workspace } from "@/lib/routes"
import { cn } from "@/lib/utils"

export function NotificationInbox({
  accountId,
  workspace,
}: {
  accountId: string
  workspace: Workspace
}) {
  const [open, setOpen] = useState(false)
  const { readIds, markRead } = useReleaseInbox(accountId)
  const unread = releases.filter((release) => !readIds.has(release.id)).length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" />}
        aria-label={unread ? `通知，${unread} 条未读` : "通知，暂无未读"}
      >
        <MailIcon data-icon="inline-start" />
        <span className="hidden sm:inline">通知</span>
        {unread > 0 ? <Badge variant="secondary">{unread}</Badge> : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={12}
        className="w-[min(25rem,calc(100vw-2rem))] gap-0 p-0"
      >
        <div className="flex items-start justify-between gap-2 p-4">
          <div className="flex flex-col gap-1">
            <PopoverTitle>通知信箱</PopoverTitle>
            <PopoverDescription>
              {unread
                ? `${unread} 条未读，看看最近的新变化。`
                : "全部已读，更新时再来看看。"}
            </PopoverDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="全部标为已读"
            disabled={unread === 0}
            onClick={() => markRead(releases.map((release) => release.id))}
          >
            <CheckCheckIcon />
          </Button>
        </div>
        <Separator />
        <ul className="max-h-[min(28rem,60dvh)] overflow-y-auto p-2">
          {releases.map((release) => {
            const isRead = readIds.has(release.id)
            const route = {
              workspace,
              page: "updates" as const,
              releaseId: release.id,
            }
            return (
              <li key={release.id}>
                <a
                  href={routeHref(route)}
                  className={cn(
                    "flex gap-3 rounded-md p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                    !isRead && "bg-muted/50"
                  )}
                  onClick={(event) => {
                    markRead([release.id])
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    event.preventDefault()
                    setOpen(false)
                    navigateTo(route)
                  }}
                >
                  <MailIcon
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-muted-foreground"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>发行说明</span>
                      <time dateTime={release.date}>
                        {releaseDate(release.date)}
                      </time>
                    </div>
                    <span
                      className={cn(
                        "text-sm leading-relaxed",
                        !isRead && "font-semibold"
                      )}
                    >
                      {release.title}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {release.summary}
                    </span>
                    {!isRead ? (
                      <span className="text-xs text-muted-foreground">
                        未读
                      </span>
                    ) : null}
                  </div>
                </a>
              </li>
            )
          })}
        </ul>
        <Separator />
        <div className="p-2">
          <Button
            variant="ghost"
            className="w-full justify-between"
            nativeButton={false}
            render={<a href={routeHref({ workspace, page: "updates" })} />}
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
              setOpen(false)
              navigateTo({ workspace, page: "updates" })
            }}
          >
            查看近期更新
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
