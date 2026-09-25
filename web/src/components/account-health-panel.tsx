import type { ProviderAccount } from "@/lib/api"
import {
  accountStatus,
  displayName,
  providerLabel,
  quotaSummary,
} from "@/components/providers/provider-helpers"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { dateTime } from "@/lib/format"

export function AccountHealthPanel({
  accounts,
  showAccounts = true,
}: {
  accounts: ProviderAccount[]
  showAccounts?: boolean
}) {
  const schedulable = accounts.filter(
    (a) => accountStatus(a).label === "可调度"
  ).length
  const issues = accounts.filter(
    (a) =>
      a.unavailable ||
      a.quota_probe_status === "error" ||
      (!a.disabled && !a.models?.length)
  )
  const groups = Array.from(new Set(accounts.map((a) => a.provider)))
    .sort()
    .map((provider) => {
      const items = accounts.filter((a) => a.provider === provider)
      return {
        provider,
        total: items.length,
        available: items.filter((a) => accountStatus(a).label === "可调度")
          .length,
        disabled: items.filter((a) => a.disabled).length,
        quota: items.filter((a) => a.quota_exceeded).length,
        probe: items.filter((a) => a.quota_probe_status === "error").length,
      }
    })
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>上游账户健康</CardTitle>
        <CardDescription>
          当前快照 · 可调度 {schedulable} / {accounts.length}
          。可调度只表示配置与调度状态，不代表连通性测试通过。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {accounts.length ? (
          <>
            <Table tabIndex={0} aria-label="提供商账户健康">
              <TableHeader>
                <TableRow>
                  <TableHead>提供商</TableHead>
                  <TableHead className="text-right">可调度 / 总数</TableHead>
                  <TableHead className="text-right">停用</TableHead>
                  <TableHead className="text-right">额度冷却</TableHead>
                  <TableHead className="text-right">探测失败</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.provider}>
                    <TableCell>{providerLabel(g.provider)}</TableCell>
                    <TableCell className="text-right">
                      {g.available} / {g.total}
                    </TableCell>
                    <TableCell className="text-right">{g.disabled}</TableCell>
                    <TableCell className="text-right">{g.quota}</TableCell>
                    <TableCell className="text-right">{g.probe}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {showAccounts &&
              (issues.length ? (
                <ul
                  className="flex flex-col gap-3"
                  aria-label="需关注的模型账户"
                >
                  {issues.slice(0, 5).map((a) => (
                    <li key={a.id || a.name} className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-all">
                          {displayName(a)}
                        </span>
                        <Badge variant={accountStatus(a).variant}>
                          {accountStatus(a).label}
                        </Badge>
                      </div>
                      <p className="text-xs break-words text-muted-foreground">
                        {a.status_message || quotaSummary(a)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        额度观测：
                        {a.quota_observed_at
                          ? dateTime(a.quota_observed_at)
                          : "尚未观测"}
                        {a.next_retry_after
                          ? ` · 下次重试 ${dateTime(a.next_retry_after)}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  当前未发现调度或额度探测异常。
                </p>
              ))}
            {showAccounts && issues.length > 5 && (
              <p className="text-xs text-muted-foreground">
                另有 {issues.length - 5} 个账户需关注，可在模型账户页查看。
              </p>
            )}
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>尚未连接模型账户</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}
