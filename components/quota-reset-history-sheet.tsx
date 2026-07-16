"use client";

import * as React from "react";
import { HistoryIcon, RefreshCwIcon, TicketCheckIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type { CredentialQuotaResetEvent } from "@/lib/admin-api";

export function QuotaResetHistorySheet({ description, load, triggerLabel }: { description: string; load: () => Promise<CredentialQuotaResetEvent[]>; triggerLabel?: string }) {
  const [open, setOpen] = React.useState(false);
  const [events, setEvents] = React.useState<CredentialQuotaResetEvent[] | null>(null);
  const [error, setError] = React.useState("");
  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setEvents(null);
    setError("");
    load().then(setEvents).catch((reason) => setError(reason instanceof Error ? reason.message : "重置记录读取失败"));
  }
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetTrigger render={<Button type="button" variant="outline" size={triggerLabel ? "sm" : "icon-sm"} aria-label="查看重置记录" />}><HistoryIcon data-icon={triggerLabel ? "inline-start" : undefined} />{triggerLabel}</SheetTrigger>
    <SheetContent className="sm:max-w-md">
      <SheetHeader><SheetTitle>额度重置记录</SheetTitle><SheetDescription>{description}</SheetDescription></SheetHeader>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        {!events && !error ? <div className="flex flex-1 items-center justify-center text-muted-foreground"><Spinner data-icon="inline-start" />读取记录中</div> : null}
        {error ? <Empty><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia><EmptyTitle>无法读取重置记录</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader></Empty> : null}
        {events?.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia><EmptyTitle>尚无重置记录</EmptyTitle><EmptyDescription>额度周期自然切换或成功兑换重置后，会在这里留下记录。</EmptyDescription></EmptyHeader></Empty> : null}
        {events && events.length > 0 ? <div className="flex flex-col">{events.map((event, index) => <ResetEventRow key={event.id} event={event} last={index === events.length - 1} />)}</div> : null}
      </div>
    </SheetContent>
  </Sheet>;
}

function ResetEventRow({ event, last }: { event: CredentialQuotaResetEvent; last: boolean }) {
  const redemption = event.source === "reset_credit";
  return <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
    <div className="flex flex-col items-center"><div className="flex size-7 items-center justify-center rounded-full bg-muted">{redemption ? <TicketCheckIcon /> : <RefreshCwIcon />}</div>{!last ? <div className="min-h-8 w-px flex-1 bg-border" /> : null}</div>
    <div className="flex flex-col gap-2 pb-6">
      <div className="flex items-start justify-between gap-3"><div className="font-medium">{redemption ? "兑换重置" : `${event.windowKind} 额度自然重置`}</div><Badge variant={redemption ? "secondary" : "outline"}>{redemption ? "兑换" : event.windowKind}</Badge></div>
      <div className="text-xs text-muted-foreground">{formatDate(event.occurredAt)}</div>
      {event.previousUsedPercent !== null ? <div className="text-sm">上一周期已使用 {Math.round(event.previousUsedPercent)}%</div> : null}
      {event.previousResetsAt && event.nextResetsAt ? <div className="text-xs text-muted-foreground">周期边界从 {formatDate(event.previousResetsAt)} 推进至 {formatDate(event.nextResetsAt)}</div> : null}
      {redemption && event.windowsReset !== null ? <div className="text-xs text-muted-foreground">本次重置 {event.windowsReset} 个额度窗口</div> : null}
    </div>
  </div>;
}

function formatDate(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
