import { useCallback, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input } from "@cloudflare/kumo/components/input"
import { Select } from "@cloudflare/kumo/components/select"
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  deleteRequest,
  postJSON,
  type OAuthStart,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

const providers = {
  codex: "Codex",
  kimi: "Kimi",
  xai: "xAI / Grok",
  openai: "OpenAI",
  "aliyun-bailian": "阿里云百炼",
}

export function AdminProvidersPage() {
  const load = useCallback(async () => {
    const value = await api<{ items: ProviderAccount[] }>(
      "/api/admin/providers/accounts"
    )
    return value.items ?? []
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取模型账户",
    onBackgroundError: (message) => toast.error(message),
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [oauthOpen, setOauthOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [oauth, setOauth] = useState<OAuthStart | null>(null)
  const [provider, setProvider] = useState("codex")
  const [oauthProvider, setOauthProvider] = useState("codex")

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/providers/accounts", {
        name: String(form.get("name") ?? ""),
        provider,
        method: "api_key",
        api_key: String(form.get("api_key") ?? ""),
        base_url: String(form.get("base_url") ?? ""),
      })
      setCreateOpen(false)
      toast.success("账户已创建")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "创建失败"))
    } finally {
      setPending(false)
    }
  }

  async function startOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      const result = await postJSON<OAuthStart>(
        "/api/admin/providers/oauth/sessions",
        { provider: oauthProvider }
      )
      setOauth(result)
      if (result.url) window.open(result.url, "_blank", "noopener")
    } catch (cause) {
      toast.error(errorMessage(cause, "无法开始授权"))
    } finally {
      setPending(false)
    }
  }

  async function submitCallback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON(
        `/api/admin/providers/oauth/sessions/${oauth.state}/callback`,
        { redirect_url: String(form.get("redirect_url") ?? "") }
      )
      toast.success("已提交回调，正在等待授权完成")
    } catch (cause) {
      toast.error(errorMessage(cause, "回调失败"))
    } finally {
      setPending(false)
    }
  }

  async function finalize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON(
        `/api/admin/providers/oauth/sessions/${oauth.state}/finalize`,
        { name: String(form.get("name") ?? "") }
      )
      setOauthOpen(false)
      setOauth(null)
      toast.success("OAuth 账户已保存")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "完成授权失败"))
    } finally {
      setPending(false)
    }
  }

  async function test(id: string) {
    try {
      const result = await postJSON<ProviderAccountTestResult>(
        `/api/admin/providers/accounts/${encodeURIComponent(id)}/test`,
        {}
      )
      toast[result.ok ? "success" : "error"](
        result.ok
          ? `连通 ${result.latency_ms}ms`
          : result.error || `上游 ${result.status_code}`
      )
    } catch (cause) {
      toast.error(errorMessage(cause, "测试失败"))
    }
  }

  async function toggle(item: ProviderAccount) {
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ disabled: !item.disabled }),
        }
      )
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "更新失败"))
    }
  }

  async function remove(id: string) {
    if (!window.confirm("删除后该凭据不再参与路由。")) return
    try {
      await deleteRequest(
        `/api/admin/providers/accounts/${encodeURIComponent(id)}`
      )
      toast.success("账户已删除")
      await reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "删除失败"))
    }
  }

  if (loading) return <LoadingState />
  if (error && data.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page
      title="模型账户"
      description="数据库加密保存的原生凭据。模型目录来自上游。"
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setOauthOpen(true)}>
            OAuth 连接
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            API Key 账户
          </Button>
        </div>
      }
    >
      <Surface>
        <DataTable
          columns={["账户", "提供商", "状态", ""]}
          empty={<EmptyState title="还没有模型账户" />}
          rows={data.map((item) => (
            <tr
              key={item.id}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2">
                <div>{item.name}</div>
                <div className="text-xs text-kumo-subtle">
                  {item.email || item.label}
                </div>
              </td>
              <td className="px-3 py-2">{item.provider}</td>
              <td className="px-3 py-2">
                {item.disabled
                  ? "停用"
                  : item.unavailable
                    ? item.status_message || "不可用"
                    : item.status || "可用"}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void test(item.id)}
                  >
                    测试
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void toggle(item)}
                  >
                    {item.disabled ? "启用" : "停用"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary-destructive"
                    onClick={() => void remove(item.id)}
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
          <Dialog.Title>用 API Key 添加账户</Dialog.Title>
          <form className="mt-4 flex flex-col gap-4" onSubmit={create}>
            <Input name="name" label="名称" required />
            <Select
              label="提供商"
              required
              value={provider}
              onValueChange={(value) => setProvider(value ?? "codex")}
              items={providers}
            />
            <SensitiveInput label="API Key" name="api_key" required />
            <Input
              name="base_url"
              label="接口地址"
              required={false}
              placeholder="可留空使用默认端点"
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                保存
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={oauthOpen}
        onOpenChange={(open) => {
          setOauthOpen(open)
          if (!open) setOauth(null)
        }}
      >
        <Dialog>
          <Dialog.Title>OAuth 连接</Dialog.Title>
          {!oauth ? (
            <form className="mt-4 flex flex-col gap-4" onSubmit={startOAuth}>
              <Select
                label="提供商"
                required
                value={oauthProvider}
                onValueChange={(value) => setOauthProvider(value ?? "codex")}
                items={{ codex: "Codex", kimi: "Kimi", xai: "xAI / Grok" }}
              />
              <div className="flex justify-end gap-2">
                <Dialog.Close
                  render={<Button variant="secondary">取消</Button>}
                />
                <Button type="submit" variant="primary" loading={pending}>
                  打开授权
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              <form className="flex flex-col gap-4" onSubmit={submitCallback}>
                <Input
                  name="redirect_url"
                  label="回调地址"
                  description="授权完成后把浏览器地址贴回来。"
                  required
                />
                <Button type="submit" variant="secondary" loading={pending}>
                  提交回调
                </Button>
              </form>
              <form className="flex flex-col gap-4" onSubmit={finalize}>
                <Input name="name" label="账户名称" required />
                <Button type="submit" variant="primary" loading={pending}>
                  完成并保存
                </Button>
              </form>
            </div>
          )}
        </Dialog>
      </Dialog.Root>
    </Page>
  )
}
