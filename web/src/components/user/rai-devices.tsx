import { useCallback, useState } from "react"
import { api, deleteRequest, type RAIDevice } from "@/lib/api"
import { dateTime } from "@/lib/format"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { PageHeader } from "@/components/workspace-ui"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"

const systems: Record<string, string> = {
  windows: "Windows",
  darwin: "macOS",
  linux: "Linux",
  freebsd: "FreeBSD",
}

export function RAIDevices() {
  const load = useCallback(async () => {
    const items =
      (await api<{ items: RAIDevice[] }>("/api/rai/devices")).items ?? []
    return items.map((device) => ({
      ...device,
      expired:
        !!device.expires_at && Date.parse(device.expires_at) <= Date.now(),
    }))
  }, [])
  const {
    data: devices,
    loading,
    error,
    reload,
  } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取 rai 已登录设备",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })
  const [selected, setSelected] = useState<RAIDevice | null>(null)
  const [pending, setPending] = useState(false)

  async function revoke() {
    if (!selected || pending) return
    setPending(true)
    try {
      await deleteRequest(`/api/rai/devices/${encodeURIComponent(selected.id)}`)
      setSelected(null)
      toast.add({ title: "设备登录已撤销", type: "success" })
      await reload()
    } catch (err) {
      toast.add({
        title: err instanceof Error ? err.message : "撤销失败，请重试",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  if (loading) return <LoadingView />
  if (error && devices.length === 0)
    return <LoadErrorView message={error} onRetry={() => void reload(true)} />

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="rai 已登录设备"
        description="管理通过浏览器授权的 rai 设备。撤销登录后，该凭据将无法发起新的请求，设备需要重新登录。"
        actions={
          <Button variant="outline" onClick={() => void reload(true)}>
            刷新
          </Button>
        }
      />
      {devices.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有 rai 登录设备</EmptyTitle>
            <EmptyDescription>
              在终端运行 rai login
              并完成浏览器授权后，设备会显示在这里。通过已有 API Key
              登录的客户端仍在 API 密钥中管理。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              role="link"
              nativeButton={false}
              render={<a href="/app/guide" />}
            >
              查看接入指南
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>设备</TableHead>
              <TableHead>系统 / 架构</TableHead>
              <TableHead>rai 版本</TableHead>
              <TableHead>授权时间</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead>登录状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((device) => {
              return (
                <TableRow key={device.id}>
                  <TableCell className="max-w-60 font-medium break-words whitespace-normal">
                    {device.device_name || "未命名设备"}
                  </TableCell>
                  <TableCell>
                    {systems[device.device_os] ??
                      (device.device_os || "系统未上报")}
                    {device.device_arch ? ` / ${device.device_arch}` : ""}
                  </TableCell>
                  <TableCell>{device.rai_version || "未上报"}</TableCell>
                  <TableCell>{dateTime(device.created_at)}</TableCell>
                  <TableCell>
                    {device.last_used_at
                      ? dateTime(device.last_used_at)
                      : "尚无调用"}
                  </TableCell>
                  <TableCell>
                    {!device.enabled
                      ? "已撤销"
                      : device.expired
                        ? "已过期"
                        : "已授权"}
                  </TableCell>
                  <TableCell className="text-right">
                    {device.enabled ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`撤销 ${device.device_name || "未命名设备"} 的登录`}
                        onClick={() => setSelected(device)}
                      >
                        撤销登录
                      </Button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">
        系统、架构和版本由 rai
        在登录时上报；最近使用表示该凭据最近一次模型调用，不代表设备当前在线。旧版未上报的信息会留空，更新
        rai 后重新登录即可补充。
      </p>
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销设备登录？</AlertDialogTitle>
            <AlertDialogDescription>
              将撤销「{selected?.device_name || "未命名设备"}」的 rai
              凭据。该设备需要重新运行 rai login
              并授权才能继续使用，其他设备不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <Button disabled={pending} onClick={() => void revoke()}>
              {pending ? "正在撤销…" : "确认撤销"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
