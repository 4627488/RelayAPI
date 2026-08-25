import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  VStack,
} from "@astryxdesign/core/Layout"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { Token } from "@astryxdesign/core/Token"
import { useToast } from "@astryxdesign/core/Toast"
import {
  CableIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import {
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusLabel,
} from "@/components/page-kit"
import {
  api,
  deleteRequest,
  type OutboundProxy,
  type ProxyTestResult,
} from "@/lib/api"

type ProxyEditor = { item: OutboundProxy | null; open: boolean }

interface ProxyRow extends Record<string, unknown> {
  id: string
  name: string
  endpoint: string
  scheme: string
  usage: string
  inUse: boolean
  item: OutboundProxy
}

function proxyLocation(result: ProxyTestResult) {
  return (
    [result.city, result.region, result.country].filter(Boolean).join(" · ") ||
    "归属地未知"
  )
}

function usageLabel(item: OutboundProxy) {
  if (item.system_use && item.account_use > 0) {
    return `系统 · ${item.account_use} 个账户`
  }
  if (item.system_use) return "系统请求"
  if (item.account_use > 0) return `${item.account_use} 个账户`
  return "未绑定"
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <HStack hAlign="between" gap={3} vAlign="center">
      <Text color="secondary">{label}</Text>
      <Text>{value}</Text>
    </HStack>
  )
}

export function ProxiesView() {
  const toast = useToast()
  const [items, setItems] = useState<OutboundProxy[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [editor, setEditor] = useState<ProxyEditor>({ item: null, open: false })
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [deleting, setDeleting] = useState<OutboundProxy | null>(null)
  const [pending, setPending] = useState(false)
  const [testingID, setTestingID] = useState("")
  const [results, setResults] = useState<Record<string, ProxyTestResult>>({})
  const [lastTestedID, setLastTestedID] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError("")
    try {
      const result = await api<{ items: OutboundProxy[] }>("/api/admin/proxies")
      setItems(result.items ?? [])
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "无法读取代理列表"
      setLoadError(message)
      toast({ type: "error", body: message })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const accountUses = useMemo(
    () => items.reduce((sum, item) => sum + item.account_use, 0),
    [items]
  )
  const tested = Object.values(results).filter((result) => result.ok).length
  const lastTested = items.find((item) => item.id === lastTestedID)
  const lastResult = lastTested ? results[lastTested.id] : undefined

  function openCreate() {
    setName("")
    setUrl("")
    setEditor({ item: null, open: true })
  }

  function openEdit(item: OutboundProxy) {
    setName(item.name)
    setUrl("")
    setEditor({ item, open: true })
  }

  async function save() {
    if (!name.trim() || (!editor.item && !url.trim())) {
      toast({ type: "error", body: "请填写代理名称和地址" })
      return
    }
    setPending(true)
    try {
      const path = editor.item
        ? `/api/admin/proxies/${encodeURIComponent(editor.item.id)}`
        : "/api/admin/proxies"
      await api(path, {
        method: editor.item ? "PATCH" : "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(url.trim() ? { url: url.trim() } : {}),
        }),
      })
      toast({ body: editor.item ? "代理已更新" : "代理已添加" })
      setEditor({ item: null, open: false })
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存代理失败",
      })
    } finally {
      setPending(false)
    }
  }

  async function test(item: OutboundProxy) {
    setTestingID(item.id)
    setLastTestedID(item.id)
    try {
      const result = await api<ProxyTestResult>(
        `/api/admin/proxies/${encodeURIComponent(item.id)}/test`,
        { method: "POST" }
      )
      setResults((current) => ({ ...current, [item.id]: result }))
      if (result.ok) {
        toast({
          body: `代理可用，落地 ${result.ip ?? "IP 未知"}，${result.latency_ms} ms`,
        })
      } else {
        toast({ type: "error", body: result.error || "代理测试失败" })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "代理测试失败"
      setResults((current) => ({
        ...current,
        [item.id]: { ok: false, latency_ms: 0, error: message },
      }))
      toast({ type: "error", body: message })
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
      toast({ body: "代理已删除" })
      setDeleting(null)
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除代理失败",
      })
    } finally {
      setPending(false)
    }
  }

  if (loading) return <LoadingView />
  if (loadError && items.length === 0) {
    return <LoadErrorView message={loadError} onRetry={() => void load()} />
  }

  const rows: ProxyRow[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    endpoint: item.endpoint,
    scheme: item.scheme,
    usage: usageLabel(item),
    inUse: item.system_use || item.account_use > 0,
    item,
  }))

  return (
    <VStack gap={4}>
      <PageHeader
        actions={
          <Button
            label="添加代理"
            variant="primary"
            icon={<PlusIcon />}
            onClick={openCreate}
          />
        }
      />

      <MetricGrid
        items={[
          { label: "代理条目", value: items.length },
          { label: "账户绑定", value: accountUses },
          { label: "本次已测", value: tested },
        ]}
      />

      <Banner
        status="info"
        title="地址与认证信息加密保存且不回显"
        description="连通性测试固定访问出口信息服务。"
        icon={<ShieldCheckIcon />}
        collapsible={false}
      />

      <SectionCard title="出站代理" description="在系统设置或模型账户中选择使用。">
        {rows.length ? (
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            columns={[
              {
                key: "name",
                header: "名称",
                width: proportional(1),
                renderCell: (row) => (
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="semibold">{row.name}</Text>
                    <Token label={row.scheme.toUpperCase()} color="gray" />
                  </HStack>
                ),
              },
              {
                key: "endpoint",
                header: "端点",
                width: proportional(2),
                renderCell: (row) => <Text type="code">{row.endpoint}</Text>,
              },
              {
                key: "usage",
                header: "用途",
                width: proportional(1),
                renderCell: (row) => (
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <StatusLabel
                      tone={row.inUse ? "success" : "neutral"}
                      label={row.inUse ? "使用中" : "未绑定"}
                    />
                    <Text color="secondary" type="supporting">
                      {row.usage}
                    </Text>
                  </HStack>
                ),
              },
              {
                key: "actions",
                header: "操作",
                width: pixel(72),
                align: "end",
                renderCell: (row) => (
                  <DropdownMenu
                    hasChevron={false}
                    button={{
                      label: `操作 ${row.name}`,
                      variant: "ghost",
                      isIconOnly: true,
                      icon: <MoreHorizontalIcon />,
                    }}
                    items={[
                      {
                        label: testingID === row.id ? "测试中…" : "测试",
                        icon: <CableIcon />,
                        isDisabled: Boolean(testingID),
                        onClick: () => void test(row.item),
                      },
                      {
                        label: "编辑",
                        icon: <PencilIcon />,
                        onClick: () => openEdit(row.item),
                      },
                      { type: "divider" },
                      {
                        label: "删除",
                        icon: <Trash2Icon />,
                        variant: "destructive",
                        isDisabled: row.inUse,
                        onClick: () => setDeleting(row.item),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            title="还没有代理"
            description="添加后可在系统设置或模型账户中选择使用。"
            icon={<NetworkIcon />}
            actions={
              <Button
                label="添加第一个代理"
                variant="primary"
                icon={<PlusIcon />}
                onClick={openCreate}
              />
            }
          />
        )}
      </SectionCard>

      {lastTested && lastResult ? (
        lastResult.ok ? (
          <SectionCard title={`测试结果 · ${lastTested.name}`}>
            <VStack gap={3}>
              <HStack hAlign="between" gap={3} vAlign="center">
                <Text color="secondary">状态</Text>
                <StatusLabel tone="success" label="代理可用" />
              </HStack>
              <Fact label="延迟" value={`${lastResult.latency_ms} ms`} />
              <Fact label="落地 IP" value={lastResult.ip || "IP 未知"} />
              <Fact
                label="归属地"
                value={`${lastResult.flag ? `${lastResult.flag} ` : ""}${proxyLocation(lastResult)}`}
              />
              <Fact
                label="网络"
                value={`${lastResult.organization || lastResult.isp || "网络归属未知"}${
                  lastResult.asn ? ` · AS${lastResult.asn}` : ""
                }`}
              />
            </VStack>
          </SectionCard>
        ) : (
          <Banner
            status="error"
            title={`${lastTested.name} 测试失败`}
            description={lastResult.error || "代理测试失败"}
            collapsible={false}
          />
        )
      ) : null}

      <Dialog
        isOpen={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        width={520}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={editor.item ? "编辑代理" : "添加代理"}
              subtitle={
                editor.item
                  ? "地址留空会保留现有密文；填写新地址才会替换。"
                  : "支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。"
              }
              onOpenChange={(open) =>
                setEditor((current) => ({ ...current, open }))
              }
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <TextInput
                  label="名称"
                  value={name}
                  onChange={setName}
                  isRequired
                  placeholder="例如 东京出口"
                />
                <TextInput
                  label={editor.item ? "代理地址（可选）" : "代理地址"}
                  value={url}
                  onChange={setUrl}
                  type="password"
                  isRequired={!editor.item}
                  isOptional={Boolean(editor.item)}
                  placeholder={
                    editor.item
                      ? "留空保持当前地址"
                      : "socks5h://user:password@proxy.example:1080"
                  }
                  description="认证信息不会返回浏览器；保存后列表只显示脱敏端点。"
                />
              </FormLayout>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2}>
                <Button
                  label="取消"
                  onClick={() => setEditor({ item: null, open: false })}
                />
                <Button
                  label="保存"
                  variant="primary"
                  isLoading={pending}
                  onClick={() => void save()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`删除“${deleting?.name ?? ""}”？`}
        description="删除后无法恢复。正在被系统或模型账户使用的代理不能删除。"
        actionLabel="删除代理"
        cancelLabel="取消"
        isActionLoading={pending}
        onAction={() => void remove()}
      />
    </VStack>
  )
}
