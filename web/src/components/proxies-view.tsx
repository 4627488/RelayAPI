import { useCallback, useMemo, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  CableIcon,
  CircleCheckIcon,
  Clock3Icon,
  Globe2Icon,
  MapPinIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

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
import { Badge } from "@/components/ui/badge"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { InfoBar, PageHeader, StatStrip } from "@/components/workspace-ui"
import { LoadErrorView } from "@/components/load-error-view"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  deleteRequest,
  type OutboundProxy,
  type ProxyTestResult,
} from "@/lib/api"

type ProxyEditor = { item: OutboundProxy | null; open: boolean }

function proxyLocation(result: ProxyTestResult) {
  return (
    [result.city, result.region, result.country].filter(Boolean).join(" · ") ||
    "归属地未知"
  )
}

export function ProxiesView() {
  const [editor, setEditor] = useState<ProxyEditor>({ item: null, open: false })
  const [deleting, setDeleting] = useState<OutboundProxy | null>(null)
  const [pending, setPending] = useState(false)
  const [testingID, setTestingID] = useState("")
  const [results, setResults] = useState<Record<string, ProxyTestResult>>({})

  const loadProxies = useCallback(async () => {
    const result = await api<{ items: OutboundProxy[] }>("/api/admin/proxies")
    return result.items ?? []
  }, [])
  const {
    data: items,
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadProxies, {
    initialData: [],
    errorMessage: "无法读取代理列表",
    onBackgroundError: (message) => toast.error(message),
  })

  const accountUses = useMemo(
    () => items.reduce((sum, item) => sum + item.account_use, 0),
    [items]
  )
  const tested = Object.values(results).filter((result) => result.ok).length

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") ?? "").trim()
    const url = String(form.get("url") ?? "").trim()
    if (!name || (!editor.item && !url)) {
      toast.error("请填写代理名称和地址")
      return
    }
    setPending(true)
    try {
      const path = editor.item
        ? `/api/admin/proxies/${encodeURIComponent(editor.item.id)}`
        : "/api/admin/proxies"
      await api(path, {
        method: editor.item ? "PATCH" : "POST",
        body: JSON.stringify({ name, ...(url ? { url } : {}) }),
      })
      toast.success(editor.item ? "代理已更新" : "代理已添加")
      setEditor({ item: null, open: false })
      await reload()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存代理失败")
    } finally {
      setPending(false)
    }
  }

  async function test(item: OutboundProxy) {
    setTestingID(item.id)
    try {
      const result = await api<ProxyTestResult>(
        `/api/admin/proxies/${encodeURIComponent(item.id)}/test`,
        { method: "POST" }
      )
      setResults((current) => ({ ...current, [item.id]: result }))
      if (result.ok) {
        toast.success(
          `代理可用，落地 ${result.ip ?? "IP 未知"}，${result.latency_ms} ms`
        )
      } else {
        toast.error(result.error || "代理测试失败")
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "代理测试失败"
      setResults((current) => ({
        ...current,
        [item.id]: { ok: false, latency_ms: 0, error: message },
      }))
      toast.error(message)
    } finally {
      setTestingID("")
    }
  }

  async function remove() {
    if (!deleting) return
    setPending(true)
    try {
      await deleteRequest(
        `/api/admin/proxies/${encodeURIComponent(deleting.id)}`
      )
      toast.success("代理已删除")
      setDeleting(null)
      await reload()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除代理失败")
    } finally {
      setPending(false)
    }
  }

  if (loading)
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Spinner />
      </div>
    )

  if (loadError && items.length === 0) {
    return (
      <LoadErrorView message={loadError} onRetry={() => void reload(true)} />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="出站代理"
        description="配置上游请求使用的网络出口并检查连通性。"
        actions={
          <Button onClick={() => setEditor({ item: null, open: true })}>
            <PlusIcon data-icon="inline-start" />
            添加代理
          </Button>
        }
      />

      <StatStrip
        className="grid-cols-3"
        items={[
          { label: "代理条目", value: items.length },
          { label: "账户绑定", value: accountUses },
          { label: "本次已测", value: tested },
        ]}
      />

      <InfoBar icon={ShieldCheckIcon}>
        地址与认证信息加密保存且不回显；连通性测试固定访问出口信息服务。
      </InfoBar>

      {items.length ? (
        <div className="grid items-stretch gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const result = results[item.id]
            const inUse = item.system_use || item.account_use > 0
            return (
              <Card
                key={item.id}
                className="flex h-full flex-col overflow-hidden"
              >
                <CardHeader>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="truncate text-base">
                        {item.name}
                      </CardTitle>
                      <Badge variant="outline" className="uppercase">
                        {item.scheme}
                      </Badge>
                    </div>
                    <CardDescription
                      className="mt-1 truncate font-mono"
                      title={item.endpoint}
                    >
                      {item.endpoint}
                    </CardDescription>
                  </div>
                  <Badge variant={inUse ? "default" : "secondary"}>
                    {inUse ? "使用中" : "未绑定"}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-4">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-muted px-3 py-2">
                      <p className="text-xs text-muted-foreground">系统请求</p>
                      <p className="mt-1 font-medium">
                        {item.system_use ? "已选择" : "未使用"}
                      </p>
                    </div>
                    <div className="rounded-md bg-muted px-3 py-2">
                      <p className="text-xs text-muted-foreground">模型账户</p>
                      <p className="mt-1 font-medium">{item.account_use} 个</p>
                    </div>
                  </div>
                  {result ? (
                    result.ok ? (
                      <Alert>
                        <CircleCheckIcon className="text-positive" />
                        <AlertTitle>代理可用</AlertTitle>
                        <AlertAction>
                          <Badge variant="outline">
                            <Clock3Icon />
                            {result.latency_ms} ms
                          </Badge>
                        </AlertAction>
                        <AlertDescription>
                          <div className="mt-2 grid gap-2 text-sm text-foreground sm:grid-cols-2">
                            <p className="flex min-w-0 items-center gap-2">
                              <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />
                              <span
                                className="truncate font-mono"
                                title={result.ip}
                              >
                                {result.ip}
                              </span>
                            </p>
                            <p className="flex min-w-0 items-center gap-2">
                              <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="truncate">
                                {result.flag} {proxyLocation(result)}
                              </span>
                            </p>
                            <p className="flex min-w-0 items-center gap-2 sm:col-span-2">
                              <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                              <span
                                className="truncate"
                                title={result.organization}
                              >
                                {result.organization ||
                                  result.isp ||
                                  "网络归属未知"}
                                {result.asn ? ` · AS${result.asn}` : ""}
                              </span>
                            </p>
                          </div>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Alert variant="destructive">
                        <TriangleAlertIcon />
                        <AlertTitle>代理测试失败</AlertTitle>
                        <AlertDescription>
                          {result.error || "未能通过该代理访问测试地址。"}
                        </AlertDescription>
                      </Alert>
                    )
                  ) : (
                    <InfoBar icon={ActivityIcon}>
                      测试后在这里显示落地 IP、归属与延迟
                    </InfoBar>
                  )}
                </CardContent>
                <CardFooter className="mt-auto flex flex-wrap gap-2 border-t bg-muted/20 pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(testingID)}
                    onClick={() => void test(item)}
                  >
                    {testingID === item.id ? <Spinner /> : <CableIcon />}
                    测试代理
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditor({ item, open: true })}
                  >
                    <PencilIcon />
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-destructive hover:text-destructive"
                    disabled={inUse}
                    title={inUse ? "请先取消系统或账户绑定" : undefined}
                    onClick={() => setDeleting(item)}
                  >
                    <Trash2Icon />
                    删除
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NetworkIcon />
                </EmptyMedia>
                <EmptyTitle>还没有代理</EmptyTitle>
                <EmptyDescription>
                  添加后可在系统设置或模型账户中选择使用。
                </EmptyDescription>
              </EmptyHeader>
              <Button onClick={() => setEditor({ item: null, open: true })}>
                <PlusIcon />
                添加第一个代理
              </Button>
            </Empty>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={save} className="contents">
            <DialogHeader>
              <DialogTitle>{editor.item ? "编辑代理" : "添加代理"}</DialogTitle>
              <DialogDescription>
                {editor.item
                  ? "地址留空会保留现有密文；填写新地址才会替换。"
                  : "支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。"}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="proxy-name">名称</FieldLabel>
                <Input
                  id="proxy-name"
                  name="name"
                  required
                  defaultValue={editor.item?.name ?? ""}
                  placeholder="例如 东京出口"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-url">
                  代理地址{editor.item ? "（可选）" : ""}
                </FieldLabel>
                <Input
                  id="proxy-url"
                  name="url"
                  required={!editor.item}
                  type="password"
                  autoComplete="new-password"
                  className="font-mono"
                  placeholder={
                    editor.item
                      ? "留空保持当前地址"
                      : "socks5h://user:password@proxy.example:1080"
                  }
                />
                <FieldDescription>
                  认证信息不会返回浏览器；保存后列表只显示脱敏端点。
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditor({ item: null, open: false })}
              >
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除“{deleting?.name}”？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复。正在被系统或模型账户使用的代理不能删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              删除代理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
