import { useCallback, useState } from "react"
import {
  ArrowUpRightIcon,
  BoxesIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react"
import { api, type TenantModel } from "@/lib/api"
import { routeHref } from "@/lib/routes"
import { copyText } from "@/lib/clipboard"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { PageHeader, SearchField } from "@/components/workspace-ui"
import { LoadErrorView } from "@/components/load-error-view"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export function UserModels() {
  const load = useCallback(
    async () =>
      (await api<{ items: TenantModel[] }>("/api/models")).items ?? [],
    []
  )
  const {
    data: models,
    loading,
    error,
    reload,
  } = useAsyncResource(load, {
    initialData: [] as TenantModel[],
    errorMessage: "无法读取模型列表",
  })
  const [search, setSearch] = useState("")
  const [mode, setMode] = useState("all")
  const filtered = models.filter(
    (model) =>
      [model.id, model.canonical_id].some((id) =>
        id?.toLowerCase().includes(search.trim().toLowerCase())
      ) &&
      (mode === "all" ||
        model.settlements.some((option) => option.mode === mode))
  )
  return (
    <div className="flex max-w-6xl min-w-0 flex-col gap-6">
      <PageHeader
        title="模型列表"
        description="查看可调用的模型 ID 与结算方式；点击订阅名称可查看额度和有效期。"
        actions={
          <>
            <Button
              variant="ghost"
              nativeButton={false}
              role="link"
              render={
                <a
                  href={routeHref({ workspace: "user", page: "subscriptions" })}
                />
              }
            >
              我的订阅
            </Button>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void reload(true)}
            >
              {loading ? (
                <Spinner />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新
            </Button>
          </>
        }
      />
      {loading && !models.length ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error && !models.length ? (
        <LoadErrorView message={error} onRetry={() => void reload(true)} />
      ) : (
        <>
          {error ? (
            <LoadErrorView message={error} onRetry={() => void reload(true)} />
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ToggleGroup
              variant="outline"
              value={[mode]}
              onValueChange={(value) => value[0] && setMode(value[0])}
              aria-label="结算方式"
            >
              <ToggleGroupItem value="all">全部模型</ToggleGroupItem>
              <ToggleGroupItem value="balance">余额结算</ToggleGroupItem>
              <ToggleGroupItem value="subscription">订阅结算</ToggleGroupItem>
            </ToggleGroup>
            <SearchField
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch("")}
              placeholder="搜索模型 ID"
              className="w-full sm:max-w-sm"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {filtered.length} 个模型。多种结算方式由系统自动匹配，API
            密钥的模型限制仍然生效。
          </p>
          {filtered.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型 ID</TableHead>
                  <TableHead>结算方式</TableHead>
                  <TableHead className="text-right">当前状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell className="max-w-72 whitespace-normal">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 font-mono text-xs break-all">
                          {model.canonical_id || model.id}
                        </span>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`复制 ${model.canonical_id || model.id}`}
                          onClick={() =>
                            void copyText(model.canonical_id || model.id)
                          }
                        >
                          <CopyIcon />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-col items-start gap-1">
                        {model.settlements.map((option, index) => (
                          <div
                            key={`${option.mode}:${option.subscription_id ?? index}`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <Button
                              variant="link"
                              nativeButton={false}
                              role="link"
                              size="sm"
                              className="h-auto justify-start p-0 text-left whitespace-normal"
                              render={
                                <a
                                  href={
                                    option.mode === "subscription"
                                      ? `${routeHref({ workspace: "user", page: "subscriptions" })}#subscription-${encodeURIComponent(option.subscription_id ?? "")}`
                                      : routeHref({
                                          workspace: "user",
                                          page: "overview",
                                        })
                                  }
                                />
                              }
                            >
                              {option.mode === "balance"
                                ? "余额结算"
                                : option.subscription_name?.includes("@")
                                  ? "模型订阅"
                                  : option.subscription_name || "模型订阅"}
                              <ArrowUpRightIcon data-icon="inline-end" />
                            </Button>
                            {option.mode === "subscription" ? (
                              <span className="text-xs text-muted-foreground">
                                订阅结算
                              </span>
                            ) : null}
                            {!option.available ? (
                              <span
                                className="subscription-signal text-xs"
                                data-tone="warning"
                              >
                                暂不可用
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className="subscription-signal text-xs font-medium"
                        data-tone={
                          model.settlements.some((option) => option.available)
                            ? "healthy"
                            : "warning"
                        }
                      >
                        {model.settlements.some((option) => option.available)
                          ? "可用"
                          : "暂不可用"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BoxesIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {models.length ? "没有匹配的模型" : "暂无可用模型"}
                </EmptyTitle>
                <EmptyDescription>
                  {models.length
                    ? "尝试调整搜索内容或结算方式。"
                    : "管理员配置模型权限后会显示在这里。"}
                </EmptyDescription>
              </EmptyHeader>
              {models.length ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch("")
                    setMode("all")
                  }}
                >
                  清除筛选
                </Button>
              ) : null}
            </Empty>
          )}
        </>
      )}
    </div>
  )
}
