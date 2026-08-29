import { useCallback, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input } from "@cloudflare/kumo/components/input"
import { Select } from "@cloudflare/kumo/components/select"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  deleteRequest,
  postJSON,
  type ChildSubscription,
  type ParentSubscriptionView,
  type User,
} from "@/lib/api"
import { money } from "@/lib/format"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function AdminSubscriptionsPage() {
  const load = useCallback(async () => {
    const [parents, children, tenants] = await Promise.all([
      api<{ items: ParentSubscriptionView[] }>(
        "/api/admin/subscriptions/parents"
      ),
      api<{ items: ChildSubscription[] }>("/api/admin/subscriptions/children"),
      api<{ items: User[] }>("/api/admin/tenants"),
    ])
    return {
      parents: parents.items ?? [],
      children: children.items ?? [],
      tenants: tenants.items ?? [],
    }
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: {
      parents: [] as ParentSubscriptionView[],
      children: [] as ChildSubscription[],
      tenants: [] as User[],
    },
    errorMessage: "无法读取订阅",
    onBackgroundError: (message) => toast.error(message),
  })
  const [assignOpen, setAssignOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [tenantId, setTenantId] = useState("")
  const [parentId, setParentId] = useState("")

  async function syncParents() {
    setPending(true)
    try {
      await postJSON("/api/admin/subscriptions/sync", {})
      toast.success("已同步父订阅")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "同步失败"))
    } finally {
      setPending(false)
    }
  }

  async function syncQuota() {
    setPending(true)
    try {
      await postJSON("/api/admin/subscriptions/quota/sync", {})
      toast.success("已观测上游额度")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "观测失败"))
    } finally {
      setPending(false)
    }
  }

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/subscriptions/children", {
        tenant_id: tenantId,
        parent_subscription_id: parentId,
        name: String(form.get("name") ?? ""),
        allocation_ppm: Math.round(
          Number(form.get("allocation_percent") || 100) * 10_000
        ),
        priority: 0,
        enabled: true,
        model_allowlist: [],
      })
      setAssignOpen(false)
      toast.success("子订阅已分配")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "分配失败"))
    } finally {
      setPending(false)
    }
  }

  async function removeChild(id: string) {
    if (!window.confirm("回收后该用户不再使用这条订阅。")) return
    try {
      await deleteRequest(`/api/admin/subscriptions/children/${id}`)
      toast.success("已回收")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "回收失败"))
    }
  }

  if (loading) return <LoadingState />
  if (error && data.parents.length === 0 && data.children.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page
      title="订阅分配"
      description="父订阅来自模型账户；子订阅按比例分给租户。"
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => void syncParents()}
          >
            同步父订阅
          </Button>
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => void syncQuota()}
          >
            观测额度
          </Button>
          <Button variant="primary" onClick={() => setAssignOpen(true)}>
            分配
          </Button>
        </div>
      }
    >
      <Surface title="父订阅">
        <DataTable
          columns={["名称", "账户", "模式", "已分配"]}
          empty={
            <EmptyState
              title="还没有父订阅"
              description="先添加模型账户再同步。"
            />
          }
          rows={data.parents.map((row) => (
            <tr
              key={row.item.id}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">{row.item.name}</td>
              <td className="px-3 py-2 text-kumo-subtle">
                {row.item.upstream_credential_name}
              </td>
              <td className="px-3 py-2">
                {row.item.capacity_mode === "observed" ? "自动观测" : "不计量"}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {(row.allocated_ppm / 10_000).toFixed(1)}%
              </td>
            </tr>
          ))}
        />
      </Surface>
      <Surface title="子订阅">
        <DataTable
          columns={["名称", "用户", "分配", ""]}
          empty={<EmptyState title="还没有分配" />}
          rows={data.children.map((item) => (
            <tr
              key={item.id}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">{item.name}</td>
              <td className="px-3 py-2">
                {data.tenants.find((user) => user.id === item.tenant_id)
                  ?.name || item.tenant_id}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {(item.allocation_ppm / 10_000).toFixed(1)}%
                {item.windows?.[0]
                  ? ` · 已用 ${money(item.windows[0].settled_nano_usd)}`
                  : ""}
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  size="sm"
                  variant="secondary-destructive"
                  onClick={() => void removeChild(item.id)}
                >
                  回收
                </Button>
              </td>
            </tr>
          ))}
        />
      </Surface>

      <Dialog.Root open={assignOpen} onOpenChange={setAssignOpen}>
        <Dialog>
          <Dialog.Title>分配子订阅</Dialog.Title>
          <form className="mt-4 flex flex-col gap-4" onSubmit={assign}>
            <Select
              label="用户"
              required
              value={tenantId || undefined}
              onValueChange={(value) => setTenantId(value ?? "")}
              items={Object.fromEntries(
                data.tenants.map((user) => [
                  user.id,
                  user.name || user.owner_email,
                ])
              )}
            />
            <Select
              label="父订阅"
              required
              value={parentId || undefined}
              onValueChange={(value) => setParentId(value ?? "")}
              items={Object.fromEntries(
                data.parents.map((row) => [row.item.id, row.item.name])
              )}
            />
            <Input name="name" label="名称" required />
            <Input
              name="allocation_percent"
              type="number"
              label="分配比例（%）"
              defaultValue="100"
              min={1}
              max={100}
              required
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                分配
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </Page>
  )
}
