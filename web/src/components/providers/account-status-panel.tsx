import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Activity01Icon } from "@hugeicons/core-free-icons"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { dateTime } from "@/lib/format"
import { accountStatus, isOAuthAccount } from "./provider-helpers"
import type {
  OutboundProxy,
  ProviderAccount,
  ProviderAccountTestResult,
} from "@/lib/api"

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function AccountStatusPanel({
  account,
  proxies,
  lastTest,
  busy,
  dirty,
  onTest,
  onToggle,
  onDelete,
  onReauthenticate,
  onEditCredentials,
}: {
  account: ProviderAccount
  proxies: OutboundProxy[]
  lastTest?: ProviderAccountTestResult
  busy: boolean
  dirty: boolean
  onTest: (account: ProviderAccount) => void
  onToggle: (account: ProviderAccount, disabled: boolean) => Promise<void>
  onDelete: (account: ProviderAccount) => void
  onReauthenticate: (account: ProviderAccount) => void
  onEditCredentials: () => void
}) {
  const oauth = isOAuthAccount(account)
  const supportsWebsocket = ["codex", "xai", "grok"].includes(
    account.provider.toLowerCase()
  )
  const status = accountStatus(account)
  const proxy = proxies.find((item) => item.id === account.proxy_id)
  const retry = account.quota_recover_at || account.next_retry_after

  return (
    <div className="flex flex-col gap-4">
      {account.disabled || account.unavailable || !account.models?.length ? (
        <Alert>
          <AlertTitle>{status.label}</AlertTitle>
          <AlertDescription>
            {account.disabled
              ? "此账户已停止接收新请求，启用后才可测试和刷新模型目录。"
              : account.status_message ||
                account.quota_reason ||
                (!account.models?.length
                  ? "尚无已发布模型，请在模型发布中选择提供给用户的模型。"
                  : "上游暂不可用，请检查授权或进行连接测试。")}
            {retry ? ` 可重试时间：${dateTime(retry)}` : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="flex flex-col gap-2">
        <Detail label="接口地址">{account.base_url || "提供商默认地址"}</Detail>
        <Detail label="连接路径">
          {proxy
            ? `${proxy.name} · ${proxy.endpoint}`
            : account.proxy_id
              ? "已配置代理（详情不可用）"
              : "直连上游"}
        </Detail>
        <Detail label="请求结果">
          {typeof account.success === "number" &&
          typeof account.failed === "number"
            ? `${account.success} 成功 / ${account.failed} 失败（运行时累计）`
            : "暂无请求统计"}
        </Detail>
        <Detail label="授权到期">
          {account.expires_at ? dateTime(account.expires_at) : "未提供到期时间"}
        </Detail>
        <Detail label="最近令牌刷新">
          {account.last_refreshed_at
            ? dateTime(account.last_refreshed_at)
            : "暂无记录"}
        </Detail>
        {retry ? <Detail label="可重试时间">{dateTime(retry)}</Detail> : null}
        {supportsWebsocket ? (
          <Detail label="WebSocket">
            {account.websockets ? "已启用" : "未启用"}
          </Detail>
        ) : null}
      </dl>
      <Separator />
      <FieldSet>
        <FieldLegend>上游额度</FieldLegend>
        <QuotaSnapshot
          snapshot={account.quota_snapshot}
          status={account.quota_probe_status}
          error={account.quota_probe_error}
          observedAt={account.quota_observed_at}
        />
        <FieldDescription>
          上游未提供额度不代表无限额度。这里只展示上游返回的观测结果。
        </FieldDescription>
      </FieldSet>
      <Separator />
      <FieldSet>
        <FieldLegend>连接诊断</FieldLegend>
        {lastTest ? (
          <Alert variant={lastTest.ok ? "default" : "destructive"}>
            <AlertTitle>
              {lastTest.ok ? "最近一次测试通过" : "最近一次测试失败"}
            </AlertTitle>
            <AlertDescription>
              {lastTest.model} · {lastTest.latency_ms} ms · HTTP{" "}
              {lastTest.status_code}
              {lastTest.error ? ` · ${lastTest.error}` : ""}
            </AlertDescription>
          </Alert>
        ) : (
          <FieldDescription>
            可调度表示未被停用或冷却；实际调用是否成功，请运行模型测试。
          </FieldDescription>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              busy || dirty || account.disabled || !account.models?.length
            }
            onClick={() => onTest(account)}
          >
            <HugeiconsIcon strokeWidth={2} icon={Activity01Icon} />
            测试已发布模型
          </Button>
          {oauth ? (
            <Button
              variant="outline"
              disabled={busy || dirty}
              onClick={() => onReauthenticate(account)}
            >
              重新授权
            </Button>
          ) : (
            <Button variant="outline" onClick={onEditCredentials}>
              更新凭据
            </Button>
          )}
        </div>
      </FieldSet>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={busy || dirty || account.can_toggle === false}
          onClick={() => void onToggle(account, !account.disabled)}
        >
          {account.disabled ? "启用账户" : "停用账户"}
        </Button>
        <Button
          variant="outline"
          disabled={busy || dirty || account.can_delete === false}
          onClick={() => onDelete(account)}
        >
          删除账户…
        </Button>
      </div>
    </div>
  )
}
