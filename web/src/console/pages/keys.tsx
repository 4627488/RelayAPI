import { useCallback, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input } from "@cloudflare/kumo/components/input"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { api, deleteRequest, postJSON, type ApiKey } from "@/lib/api"
import { dateTime } from "@/lib/format"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function KeysPage() {
  const load = useCallback(async () => {
    const value = await api<{ items: ApiKey[] }>("/api/keys")
    return value.items ?? []
  }, [])
  const {
    data: keys,
    loading,
    error,
    reload,
  } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取密钥",
    onBackgroundError: (message) => toast.error(message),
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [createdKey, setCreatedKey] = useState("")
  const [secret, setSecret] = useState("")
  const [pending, setPending] = useState(false)

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const result = await postJSON<{ item: ApiKey; key: string }>(
        "/api/keys",
        {
          name: String(data.get("name") ?? "default"),
          enabled: true,
          model_allowlist: [],
          model_aliases: [],
        }
      )
      setCreatedKey(result.key)
      setCreateOpen(false)
      toast.success("密钥已创建")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "创建失败"))
    } finally {
      setPending(false)
    }
  }

  async function reveal(id: string) {
    try {
      const result = await api<{ key: string }>(`/api/keys/${id}/secret`)
      setSecret(result.key)
    } catch (cause) {
      toast.error(errorMessage(cause, "无法读取密钥"))
    }
  }

  async function toggle(key: ApiKey) {
    try {
      await api(`/api/keys/${key.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: key.name,
          enabled: !key.enabled,
          rate_limit_per_minute: key.rate_limit_per_minute,
          token_limit_daily: key.token_limit_daily,
          model_allowlist: key.model_allowlist,
          model_aliases: key.model_aliases,
        }),
      })
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "更新失败"))
    }
  }

  async function remove(id: string) {
    if (!window.confirm("删除后客户端将无法再使用这把 Key。")) return
    try {
      await deleteRequest(`/api/keys/${id}`)
      toast.success("密钥已删除")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "删除失败"))
    }
  }

  if (loading) return <LoadingState />
  if (error && keys.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page
      title="API Keys"
      description="列表永不返回明文。可恢复的 Key 可以按需查看。"
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          新建 Key
        </Button>
      }
    >
      {createdKey ? (
        <Surface title="新密钥只显示这一次">
          <ClipboardText text={createdKey} />
        </Surface>
      ) : null}
      {secret ? (
        <Surface title="已恢复的密钥">
          <ClipboardText text={secret} />
        </Surface>
      ) : null}
      <Surface>
        <DataTable
          columns={["名称", "前缀", "状态", "最近使用", ""]}
          empty={
            <EmptyState
              title="还没有 API Key"
              description="先创建一把再接入客户端。"
            />
          }
          rows={keys.map((key) => (
            <tr
              key={key.id}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">{key.name}</td>
              <td className="px-3 py-2 font-mono text-[0.9em]">{key.prefix}</td>
              <td className="px-3 py-2">{key.enabled ? "启用" : "停用"}</td>
              <td className="px-3 py-2 text-kumo-subtle">
                {dateTime(key.last_used_at)}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  {key.recoverable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void reveal(key.id)}
                    >
                      查看
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void toggle(key)}
                  >
                    {key.enabled ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary-destructive"
                    onClick={() => void remove(key.id)}
                  >
                    删除
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        />
      </Surface>

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog>
          <Dialog.Title>新建 API Key</Dialog.Title>
          <Dialog.Description>创建后明文只返回一次。</Dialog.Description>
          <form className="mt-4 flex flex-col gap-4" onSubmit={create}>
            <Input name="name" label="名称" defaultValue="default" required />
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                创建
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </Page>
  )
}
