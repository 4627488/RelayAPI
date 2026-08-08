import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { CheckCircle2Icon, DatabaseIcon, KeyRoundIcon, NetworkIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api, deleteRequest, type ProviderAccount } from "@/lib/api"

const providers = ["codex", "openai", "claude", "gemini", "gemini-interactions", "aistudio", "vertex", "antigravity", "kimi", "xai"]

const credentialExamples: Record<string, object> = {
  openai: { type: "openai", api_key: "sk-...", base_url: "https://api.openai.com/v1" },
  claude: { type: "claude", api_key: "sk-ant-..." },
  gemini: { type: "gemini", api_key: "..." },
  codex: { type: "codex", access_token: "...", refresh_token: "...", email: "name@example.com" },
}

function displayName(account: ProviderAccount) { return account.label || account.email || account.name }

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [search, setSearch] = useState("")
  const [provider, setProvider] = useState("all")
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState<ProviderAccount | null>(null)
  const [deleting, setDeleting] = useState<ProviderAccount | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const result = await api<{ files: ProviderAccount[] }>("/api/admin/providers/accounts"); setAccounts(result.files ?? []) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "无法读取模型账户") }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  const providerOptions = useMemo(() => [...new Set(accounts.map((item) => item.provider))].sort(), [accounts])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return accounts.filter((item) => (provider === "all" || item.provider === provider) && (!needle || [displayName(item), item.name, item.provider, ...(item.models ?? [])].some((part) => part.toLowerCase().includes(needle))))
  }, [accounts, provider, search])
  const enabled = accounts.filter((item) => !item.disabled && !item.unavailable).length
  const modelCount = new Set(accounts.flatMap((item) => item.models ?? [])).size

  async function toggle(account: ProviderAccount, disabled: boolean) {
    setPending(true)
    try {
      await api(`/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`, { method: "PATCH", body: JSON.stringify({ disabled }) })
      toast.success(disabled ? "凭据已停用" : "凭据已启用"); setSelected(null); await load()
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "更新失败") }
    finally { setPending(false) }
  }

  async function remove() {
    if (!deleting) return
    setPending(true)
    try { await deleteRequest(`/api/admin/providers/accounts/${encodeURIComponent(deleting.id || deleting.name)}`); toast.success("凭据已删除"); setDeleting(null); setSelected(null); await load() }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "删除失败") }
    finally { setPending(false) }
  }

  if (loading) return <div className="flex min-h-56 items-center justify-center"><Spinner /></div>

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="mb-2 flex items-center gap-2"><Badge variant="secondary">Native</Badge><span className="text-xs text-muted-foreground">数据库凭据仓库</span></div><h1 className="text-2xl font-semibold tracking-tight">模型账户</h1><p className="mt-1 text-sm text-muted-foreground">管理内置推理引擎直接使用的上游凭据和模型路由。</p></div>
        <Button onClick={() => setAddOpen(true)}><PlusIcon />添加凭据</Button>
      </div>

      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
        {[["凭据总数",accounts.length],["当前启用",enabled],["公开模型",modelCount]].map(([label,value]) => <div key={label} className="bg-background px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>)}
      </div>

      <Alert><DatabaseIcon /><AlertTitle>凭据由 RelayAPI 托管</AlertTitle><AlertDescription>凭据文档整体加密存入数据库，修改后会立即重建 native 路由。此页面不会返回 API Key 或令牌明文。</AlertDescription></Alert>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、提供商或模型" className="pl-9" /></div>
        <Select value={provider} onValueChange={(next) => { if (next) setProvider(next) }}><SelectTrigger className="w-full sm:w-52"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部提供商</SelectItem>{providerOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent></Select>
      </div>

      {filtered.length ? <div className="grid gap-3 lg:grid-cols-2">{filtered.map((account) => (
        <Card key={account.id || account.name} className="transition-colors hover:border-foreground/20">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex min-w-0 gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-xs font-semibold uppercase">{account.provider.slice(0,2)}</div><div className="min-w-0"><CardTitle className="truncate text-base">{displayName(account)}</CardTitle><CardDescription className="mt-1 truncate font-mono text-xs">{account.id || account.name}</CardDescription></div></div>
            <Badge variant={account.disabled || account.unavailable ? "secondary" : "default"}>{account.disabled ? "已停用" : account.unavailable ? "已过期" : "运行中"}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5">{(account.models ?? []).slice(0,5).map((model) => <Badge key={model} variant="outline" className="font-mono font-normal">{model}</Badge>)}{(account.models?.length ?? 0)>5?<Badge variant="secondary">+{(account.models?.length ?? 0)-5}</Badge>:null}</div>
            <div className="flex items-center gap-3 border-t pt-3 text-xs text-muted-foreground"><span>{account.provider}</span>{account.proxy_configured ? <span className="flex items-center gap-1"><NetworkIcon className="size-3" />独立代理</span>:null}<Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(account)}>管理</Button></div>
          </CardContent>
        </Card>
      ))}</div> : <Card><CardContent className="py-12"><Empty><EmptyHeader><EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia><EmptyTitle>{accounts.length ? "没有匹配的凭据" : "还没有 native 凭据"}</EmptyTitle><EmptyDescription>{accounts.length ? "调整搜索或提供商筛选。" : "添加上游 API Key 或导入 OAuth 凭据文档以开始路由。"}</EmptyDescription></EmptyHeader>{!accounts.length?<Button onClick={() => setAddOpen(true)}><PlusIcon />添加凭据</Button>:null}</Empty></CardContent></Card>}

      <AddCredentialDialog open={addOpen} onOpenChange={setAddOpen} pending={pending} setPending={setPending} onSaved={load} />

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if(!open)setSelected(null) }}><DialogContent className="sm:max-w-xl">{selected ? <><DialogHeader><DialogTitle>{displayName(selected)}</DialogTitle><DialogDescription className="font-mono">{selected.id || selected.name}</DialogDescription></DialogHeader><dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">提供商</dt><dd className="mt-1 font-medium">{selected.provider}</dd></div><div><dt className="text-xs text-muted-foreground">代理</dt><dd className="mt-1 font-medium">{selected.proxy_configured?"使用账户独立代理":"使用全局网络设置"}</dd></div><div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">公开模型</dt><dd className="mt-2 flex flex-wrap gap-1.5">{selected.models?.map((model)=><Badge key={model} variant="outline" className="font-mono font-normal">{model}</Badge>)}</dd></div></dl><DialogFooter className="sm:justify-between"><Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(selected)}><Trash2Icon />删除</Button><Button variant="outline" disabled={pending} onClick={() => void toggle(selected,!selected.disabled)}>{selected.disabled?"启用凭据":"停用凭据"}</Button></DialogFooter></>:null}</DialogContent></Dialog>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if(!open)setDeleting(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除“{deleting ? displayName(deleting) : ""}”？</AlertDialogTitle><AlertDialogDescription>该凭据会从加密数据库和 native 路由中立即移除，此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={() => void remove()}>删除凭据</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  )
}

function AddCredentialDialog({ open, onOpenChange, pending, setPending, onSaved }: { open: boolean; onOpenChange: (open:boolean)=>void; pending:boolean; setPending:(value:boolean)=>void; onSaved:()=>Promise<void> }) {
  const [provider, setProvider] = useState("openai")
  const [document, setDocument] = useState(() => JSON.stringify(credentialExamples.openai,null,2))
  function changeProvider(next:string) { setProvider(next); setDocument(JSON.stringify(credentialExamples[next] ?? {type:next,api_key:"..."},null,2)) }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=new FormData(event.currentTarget); let parsed:unknown
    try { parsed=JSON.parse(document) } catch { toast.error("凭据文档不是有效 JSON"); return }
    const models=String(form.get("models")??"").split(/[\n,]/).map((item)=>item.trim()).filter(Boolean)
    if(!models.length){toast.error("至少填写一个公开模型");return}
    setPending(true)
    try { await api("/api/admin/providers/accounts",{method:"POST",body:JSON.stringify({name:String(form.get("name")??""),provider,models,document:parsed})}); toast.success("native 凭据已添加"); onOpenChange(false); await onSaved() }
    catch(cause){toast.error(cause instanceof Error?cause.message:"添加失败")}
    finally{setPending(false)}
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>添加 native 凭据</DialogTitle><DialogDescription>凭据 JSON 只会发送到 RelayAPI，并以应用加密密钥密封保存。</DialogDescription></DialogHeader><form id="add-native-credential" onSubmit={submit}><FieldGroup>
    <div className="grid gap-5 sm:grid-cols-2"><Field><FieldLabel htmlFor="credential-name">显示名称</FieldLabel><Input id="credential-name" name="name" required placeholder="例如 OpenAI 主账户" /></Field><Field><FieldLabel>提供商</FieldLabel><Select value={provider} onValueChange={(next) => { if (next) changeProvider(next) }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{providers.map((item)=><SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent></Select></Field></div>
    <Field><FieldLabel htmlFor="credential-models">公开模型</FieldLabel><Textarea id="credential-models" name="models" rows={3} required placeholder={"gpt-5.4\ngpt-image-1"} className="font-mono text-xs"/><FieldDescription>每行或逗号分隔。模型别名可在 document.model_routes 中声明。</FieldDescription></Field>
    <Field><FieldLabel htmlFor="credential-document">凭据文档</FieldLabel><Textarea id="credential-document" value={document} onChange={(event)=>setDocument(event.target.value)} rows={10} required spellCheck={false} className="font-mono text-xs"/><FieldDescription>可包含 api_key、access_token、refresh_token、base_url、proxy_url、prefix、headers 和 model_routes。</FieldDescription></Field>
  </FieldGroup></form><DialogFooter><Button variant="outline" onClick={()=>onOpenChange(false)}>取消</Button><Button type="submit" form="add-native-credential" disabled={pending}>{pending?<Spinner/>:<CheckCircle2Icon/>}验证并添加</Button></DialogFooter></DialogContent></Dialog>
}
