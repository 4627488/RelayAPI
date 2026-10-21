import { Fragment, useCallback, useEffect, useState } from "react"
import {
  Clock3Icon,
  KeyRoundIcon,
  LaptopIcon,
  LogOutIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TerminalSquareIcon,
} from "lucide-react"

import { api, deleteRequest, type RAIDevice } from "@/lib/api"
import { deviceActivity, deviceTimestamp } from "@/lib/device-activity"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { PageHeader } from "@/components/workspace-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
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

const systems = {
  windows: { name: "Windows", icon: MonitorIcon },
  darwin: { name: "macOS", icon: LaptopIcon },
  linux: { name: "Linux", icon: TerminalSquareIcon },
  freebsd: { name: "FreeBSD", icon: TerminalSquareIcon },
  android: { name: "Android", icon: SmartphoneIcon },
  ios: { name: "iOS", icon: SmartphoneIcon },
}
const architectures: Record<string, string> = {
  amd64: "x64",
  arm64: "ARM64",
  "386": "x86",
  arm: "ARM",
}

function systemInfo(os: string) {
  return (
    systems[os as keyof typeof systems] ?? {
      name: os || "系统未上报",
      icon: MonitorSmartphoneIcon,
    }
  )
}

export function RAIDevices() {
  const load = useCallback(async () => {
    return (await api<{ items: RAIDevice[] }>("/api/rai/devices")).items ?? []
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取设备，请稍后重试",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })
  const [selected, setSelected] = useState<RAIDevice | null>(null)
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [revokedIds, setRevokedIds] = useState(() => new Set<string>())
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = window.setInterval(update, 60_000)
    window.addEventListener("focus", update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", update)
    }
  }, [])

  const devices = data
    .filter(
      (device) =>
        device.enabled &&
        !revokedIds.has(device.id) &&
        (!device.expires_at || Date.parse(device.expires_at) > now)
    )
    .sort(
      (a, b) =>
        Date.parse(b.last_used_at || b.created_at) -
        Date.parse(a.last_used_at || a.created_at)
    )

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    await reload()
    setNow(Date.now())
    setRefreshing(false)
  }

  async function revoke() {
    if (!selected || pending) return
    const id = selected.id
    setPending(true)
    try {
      await deleteRequest(`/api/rai/devices/${encodeURIComponent(id)}`)
      setRevokedIds((previous) => new Set([...previous, id]))
      setSelected(null)
      toast.add({ title: "已取消设备授权", type: "success" })
      await reload()
    } catch (err) {
      toast.add({
        title: err instanceof Error ? err.message : "取消授权失败，请重试",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  if (loading) return <LoadingView />
  if (error && data.length === 0)
    return <LoadErrorView message={error} onRetry={() => void reload(true)} />

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-8 py-2 md:py-4">
      <PageHeader
        title="设备"
        description="查看你已授权的设备，管理它们对 RelayAPI 的访问权限。"
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新设备"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon />
            </Button>
            <Button
              variant="outline"
              role="link"
              nativeButton={false}
              render={<a href="/rai/authorize" />}
            >
              <PlusIcon data-icon="inline-start" />
              授权设备
            </Button>
          </>
        }
      />
      <section
        aria-labelledby="authorized-devices"
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 id="authorized-devices" className="text-sm font-medium">
              已授权设备
            </h2>
            <Badge variant="secondary" aria-label={`${devices.length} 个设备`}>
              {devices.length}
            </Badge>
          </div>
          {devices.length > 1 ? (
            <p className="text-xs text-muted-foreground">按最近活动排序</p>
          ) : null}
        </div>
        {devices.length === 0 ? (
          <Empty className="border py-14">
            <EmptyHeader>
              <EmptyMedia>
                <MonitorSmartphoneIcon
                  aria-hidden="true"
                  className="size-10 text-muted-foreground"
                />
              </EmptyMedia>
              <EmptyTitle>还没有已授权的设备</EmptyTitle>
              <EmptyDescription>
                在终端运行 <code>rai auth login</code>
                ，按提示完成授权。远程设备可使用 <code>--no-browser</code>
                ，再在这里输入验证码。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                role="link"
                nativeButton={false}
                render={<a href="/app/guide" />}
              >
                查看接入指南
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ItemGroup
            aria-label="已授权设备"
            className="gap-0 rounded-xl border px-4 sm:px-6"
          >
            {devices.map((device, index) => {
              const system = systemInfo(device.device_os)
              const DeviceIcon = system.icon
              const management = device.purpose === "account"
              const PurposeIcon = management ? ShieldCheckIcon : KeyRoundIcon
              return (
                <Fragment key={device.id}>
                  {index > 0 ? <ItemSeparator /> : null}
                  <Item
                    role="listitem"
                    className="items-start gap-4 px-0 py-5 sm:gap-5"
                  >
                    <ItemMedia className="pt-1">
                      <DeviceIcon
                        aria-hidden="true"
                        className="size-7 text-muted-foreground"
                      />
                    </ItemMedia>
                    <ItemContent className="min-w-0 gap-2">
                      <ItemTitle className="max-w-full">
                        <span
                          className="truncate"
                          title={device.device_name || "未命名设备"}
                        >
                          {device.device_name || "未命名设备"}
                        </span>
                      </ItemTitle>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{system.name}</span>
                        {device.device_arch ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {architectures[device.device_arch] ||
                                device.device_arch}
                            </span>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>rai {device.rai_version || "版本未上报"}</span>
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <PurposeIcon
                            aria-hidden="true"
                            className="size-3.5"
                          />
                          {management ? "账户管理" : "模型调用"}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <Clock3Icon aria-hidden="true" className="size-3.5" />
                          {management ? (
                            "未记录使用时间"
                          ) : device.last_used_at &&
                            Number.isFinite(Date.parse(device.last_used_at)) ? (
                            <time
                              dateTime={device.last_used_at}
                              title={deviceTimestamp(device.last_used_at)}
                            >
                              {deviceActivity(device.last_used_at, now)}
                            </time>
                          ) : (
                            "尚未使用"
                          )}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <time
                          dateTime={device.created_at}
                          title={deviceTimestamp(device.created_at)}
                        >
                          授权于 {deviceTimestamp(device.created_at)}
                        </time>
                        {device.expires_at ? (
                          <span className="ml-3">
                            有效至 {deviceTimestamp(device.expires_at)}
                          </span>
                        ) : null}
                      </p>
                    </ItemContent>
                    <ItemActions className="ml-11 basis-full sm:ml-0 sm:basis-auto">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`取消 ${device.device_name || "未命名设备"} 的授权`}
                        onClick={() => setSelected(device)}
                      >
                        <LogOutIcon data-icon="inline-start" />
                        取消授权
                      </Button>
                    </ItemActions>
                  </Item>
                </Fragment>
              )
            })}
          </ItemGroup>
        )}
        <p className="text-xs leading-6 text-muted-foreground">
          仅保留有效的 rai
          设备授权。最近使用时间来自模型调用，不代表设备当前在线；账户管理授权暂不记录使用时间。使用已有
          API Key 的客户端请在{" "}
          <a href="/app/keys" className="underline underline-offset-4">
            API 密钥
          </a>{" "}
          中管理。
        </p>
      </section>
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>取消设备授权？</AlertDialogTitle>
            <AlertDialogDescription>
              「{selected?.device_name || "未命名设备"}」将无法继续
              {selected?.purpose === "account" ? "管理你的账户" : "调用模型"}
              ，并会从设备列表中移除。如需再次使用，请在该设备运行{" "}
              <code>
                rai auth login
                {selected?.purpose === "account" ? " --scope account" : ""}
              </code>{" "}
              重新授权。其他设备不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>保留授权</AlertDialogCancel>
            <Button disabled={pending} onClick={() => void revoke()}>
              {pending ? "正在取消…" : "确认取消授权"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
