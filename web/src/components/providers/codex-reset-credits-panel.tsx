import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { api, type CodexResetCredits } from "@/lib/api"
import { dateTime } from "@/lib/format"

const outcomes: Record<string, string> = {
  reset: "已使用一次重置。",
  already_redeemed: "这次重置已完成，没有重复扣除次数。",
  nothing_to_reset: "当前没有可重置的额度窗口，未消耗次数。",
  no_credit: "当前没有可用的重置次数。",
}

function creditTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

export function CodexResetCreditsPanel({
  accountID,
  accountName,
  disabled,
  onConsumed,
}: {
  accountID: string
  accountName: string
  disabled: boolean
  onConsumed: () => Promise<void>
}) {
  const [data, setData] = useState<CodexResetCredits | null>(null)
  const [loading, setLoading] = useState(false)
  const [consuming, setConsuming] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const storageKey = `codex-reset-attempt:${accountID}`
  const [attempt, setAttempt] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const inFlight = useRef(false)
  const endpoint = `/api/admin/providers/accounts/${encodeURIComponent(accountID)}/codex-reset-credits`
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError("")
      try {
        const result = await api<CodexResetCredits>(endpoint, { signal })
        if (!signal?.aborted) setData(result)
      } catch (cause) {
        if (!signal?.aborted) {
          setData(null)
          setError(cause instanceof Error ? cause.message : "无法查询重置次数")
        }
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [endpoint]
  )
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  async function consume() {
    if (inFlight.current || disabled) return
    inFlight.current = true
    setConsuming(true)
    setError("")
    setMessage("")
    // Retain the ID after an uncertain result so a retry cannot spend another credit.
    try {
      const requestID = attempt ?? crypto.randomUUID()
      sessionStorage.setItem(storageKey, requestID)
      setAttempt(requestID)
      const result = await api<{ code: string; windows_reset: number }>(
        `${endpoint}/consume`,
        {
          method: "POST",
          body: JSON.stringify({ redeem_request_id: requestID }),
        }
      )
      if (!outcomes[result.code])
        throw new Error("重置结果未知，请重试确认结果")
      sessionStorage.removeItem(storageKey)
      setAttempt(null)
      setMessage(outcomes[result.code])
      setConfirmOpen(false)
      await refresh()
      if (result.code === "reset" || result.code === "already_redeemed") {
        try {
          await onConsumed()
        } catch {
          setError("重置已完成，但额度快照刷新失败。请稍后刷新上游额度。")
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "请求失败，请重试确认结果"
      )
    } finally {
      inFlight.current = false
      setConsuming(false)
    }
  }

  return (
    <FieldSet>
      <FieldLegend>积攒的重置次数（Banked resets）</FieldLegend>
      {loading ? (
        <FieldDescription>
          <Spinner /> 正在查询…
        </FieldDescription>
      ) : null}
      {data ? (
        <>
          <p className="text-sm">可用 {data.available_count} 次</p>
          <FieldDescription>
            查询于 {dateTime(data.observed_at)}
          </FieldDescription>
          {data.credits == null ? (
            <FieldDescription>上游未提供每次重置的到期明细。</FieldDescription>
          ) : (
            <dl className="flex flex-col gap-3">
              {data.credits.map((credit) => (
                <div key={credit.id} className="flex flex-col gap-1 text-xs">
                  <dt>{credit.title || "额度重置"}</dt>
                  <dd className="text-muted-foreground">
                    {credit.status === "available"
                      ? "可用"
                      : credit.status === "redeemed"
                        ? "已使用"
                        : credit.status === "expired"
                          ? "已过期"
                          : credit.status}
                    {credit.granted_at
                      ? ` · 获得于 ${creditTime(credit.granted_at)}`
                      : ""}
                    {credit.expires_at
                      ? ` · 到期于 ${creditTime(credit.expires_at)}`
                      : " · 未提供到期时间"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <FieldDescription>
            总次数以上游返回为准，明细可能仅展示部分记录。
          </FieldDescription>
        </>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {error && !confirmOpen ? (
        <Alert variant="destructive">
          <AlertTitle>查询或重置未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={loading || consuming || disabled}
          onClick={() => void refresh()}
        >
          刷新重置次数
        </Button>
        <Button
          disabled={
            loading ||
            consuming ||
            disabled ||
            (!attempt && (!data || data.available_count <= 0))
          }
          onClick={() => setConfirmOpen(true)}
        >
          {attempt ? "重试确认重置结果" : "使用一次重置"}
        </Button>
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!consuming) setConfirmOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>使用一次 Codex 重置？</AlertDialogTitle>
            <AlertDialogDescription>
              将为账户「{accountName}」消耗一次积攒的重置，由 Codex
              选择可用记录并重置符合条件的额度窗口。到期时间是该次重置的有效期。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>重置结果待确认</AlertTitle>
              <AlertDescription>
                {error}；重试会继续确认同一次操作。
              </AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={consuming}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={consuming || disabled}
              onClick={() => void consume()}
            >
              {consuming ? <Spinner data-icon="inline-start" /> : null}确认使用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldSet>
  )
}
