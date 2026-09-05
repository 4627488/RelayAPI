import { useEffect, useState } from "react"
import { ActivityIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  api,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"
import {
  accountKey,
  displayName,
  providerLabel,
  publishedModels,
} from "@/components/providers/provider-helpers"

export function TestAccountDialog({
  account,
  onOpenChange,
  onResult,
}: {
  account: ProviderAccount | null
  onOpenChange: (open: boolean) => void
  onResult: (
    account: ProviderAccount,
    result: ProviderAccountTestResult
  ) => void
}) {
  const models = account ? publishedModels(account) : []
  const [model, setModel] = useState("")
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ProviderAccountTestResult | null>(null)

  useEffect(() => {
    if (!account) {
      setModel("")
      setPending(false)
      setResult(null)
      return
    }
    setModel(publishedModels(account)[0] ?? "")
    setPending(false)
    setResult(null)
  }, [account])

  async function run() {
    if (!account || !model) return
    setPending(true)
    try {
      const next = await api<ProviderAccountTestResult>(
        `/api/admin/providers/accounts/${encodeURIComponent(accountKey(account))}/test`,
        { method: "POST", body: JSON.stringify({ model }) }
      )
      setResult(next)
      onResult(account, next)
      if (next.ok) {
        toast.add({
          title: `${model} 可用，${next.latency_ms} ms`,
          type: "success",
        })
      } else {
        toast.add({ title: next.error || `${model} 测试失败`, type: "error" })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "测试失败"
      const failed: ProviderAccountTestResult = {
        ok: false,
        model,
        provider: account.provider,
        status_code: 0,
        latency_ms: 0,
        error: message,
      }
      setResult(failed)
      onResult(account, failed)
      toast.add({ title: message, type: "error" })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>测试模型</DialogTitle>
          <DialogDescription>
            {account
              ? `${displayName(account)} · ${providerLabel(account.provider)}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>公开模型</FieldLabel>
            <Select
              items={models.map((item) => ({ value: item, label: item }))}
              value={model}
              onValueChange={(next) => {
                if (next) setModel(next)
              }}
            >
              <SelectTrigger className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {models.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              向该账户发送一次最短非流式请求。不经过用户计费，但会真实打到上游。
            </FieldDescription>
          </Field>
          {result ? (
            <div className="px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {result.ok ? <CircleCheckIcon /> : <TriangleAlertIcon />}
                  {result.ok ? "通过" : "失败"}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {result.status_code || "—"} · {result.latency_ms} ms
                </p>
              </div>
              <p className="mt-2 font-mono text-xs wrap-break-word text-muted-foreground">
                {result.preview || result.error || "上游没有返回可读内容"}
              </p>
            </div>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button disabled={pending || !model} onClick={() => void run()}>
            {pending ? <Spinner /> : <ActivityIcon />}
            {result ? "再测一次" : "发送测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
