"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  CopyIcon,
  ImageIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RouteIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";

import {
  ApiKeyBaseFields,
  EMPTY_API_KEY_FORM,
  apiKeyFormToPayload,
  apiKeyToForm,
  assertApiKey,
  parseList,
  type ApiKeyFormState,
} from "@/components/workspace/api-key-form";
import { formatDateTime } from "@/components/workspace/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminErrorMessage,
  createApiKey,
  deleteApiKey,
  transferApiKeyToTenant,
  updateApiKey,
  type ApiKeyTransferResponse,
} from "@/lib/admin-api";
import type {
  ChannelRecord,
  ChannelStatus,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
} from "@/src/shared/types/entities";

const STATUS_LABELS: Record<ChannelStatus, string> = {
  healthy: "健康",
  degraded: "降级",
  cooling_down: "冷却中",
  disabled: "已禁用",
};

export function ApiKeysSection({
  apiKeys,
  channels,
  onCreated,
  onDeleted,
  onTransferred,
  onUpdated,
  tenants,
}: {
  apiKeys: PublicApiKey[];
  channels: ChannelRecord[];
  onCreated: (apiKey: CreatedApiKey) => void;
  onDeleted: (id: string) => void;
  onTransferred: (result: ApiKeyTransferResponse) => void;
  onUpdated: (apiKey: PublicApiKey) => void;
  tenants: PublicTenant[];
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createdKey, setCreatedKey] = React.useState<CreatedApiKey | null>(
    null,
  );
  const [editingApiKey, setEditingApiKey] = React.useState<PublicApiKey | null>(
    null,
  );
  const [transferringApiKey, setTransferringApiKey] =
    React.useState<PublicApiKey | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function toggleEnabled(apiKey: PublicApiKey, enabled: boolean) {
    setPendingId(apiKey.id);
    try {
      const updated = await updateApiKey(apiKey.id, { enabled });
      onUpdated(updated);
      toast.success(enabled ? "API 密钥已启用" : "API 密钥已禁用");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function remove(apiKey: PublicApiKey) {
    setPendingId(apiKey.id);
    try {
      await deleteApiKey(apiKey.id);
      onDeleted(apiKey.id);
      toast.success("API 密钥已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API 密钥</CardTitle>
          <CardAction>
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              新建
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {apiKeys.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>还没有 Relay API 密钥</EmptyTitle>
                <EmptyDescription>创建后即可调用 Relay。</EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                新建
              </Button>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>权限范围</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>上限</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((apiKey) => (
                  <TableRow key={apiKey.id}>
                    <TableCell className="font-medium">{apiKey.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {apiKey.prefix}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={apiKey.enabled}
                          disabled={pendingId === apiKey.id}
                          size="sm"
                          onCheckedChange={(checked) =>
                            toggleEnabled(apiKey, Boolean(checked))
                          }
                        />
                        {renderEnabledBadge(apiKey.enabled)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {renderStringList(apiKey.scopes, "全部")}
                    </TableCell>
                    <TableCell>
                      {renderStringList(apiKey.modelAllowlist, "全部模型")}
                    </TableCell>
                    <TableCell>
                      {apiKey.tokenLimitDaily === null
                        ? "不限制"
                        : formatTokenNumber(apiKey.tokenLimitDaily)}
                    </TableCell>
                    <TableCell>
                      {formatNullableDate(apiKey.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="复制热力图 Markdown"
                          title="复制热力图 Markdown"
                          onClick={() =>
                            void copyText(
                              activityHeatmapMarkdown({
                                apiKeyId: apiKey.id,
                                label: apiKey.name,
                                absolute: true,
                              }),
                            )
                          }
                        >
                          <ImageIcon data-icon="inline-start" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pendingId === apiKey.id || tenants.length === 0}
                          aria-label="转让 API 密钥"
                          title={
                            tenants.length === 0
                              ? "暂无可转让的租户"
                              : "转让给租户"
                          }
                          onClick={() => setTransferringApiKey(apiKey)}
                        >
                          <SendIcon data-icon="inline-start" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="编辑 API 密钥"
                          title="编辑 API 密钥"
                          onClick={() => setEditingApiKey(apiKey)}
                        >
                          <PencilIcon data-icon="inline-start" />
                        </Button>
                        <ApiKeyDeleteDialog
                          apiKey={apiKey}
                          disabled={pendingId === apiKey.id}
                          onConfirm={() => remove(apiKey)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ApiKeyFormDialog
        channels={channels}
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => {
          onCreated(created as CreatedApiKey);
          setCreatedKey(created as CreatedApiKey);
        }}
      />
      <ApiKeyFormDialog
        apiKey={editingApiKey}
        channels={channels}
        mode="edit"
        open={Boolean(editingApiKey)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingApiKey(null);
          }
        }}
        onSaved={(updated) => {
          onUpdated(updated);
          setEditingApiKey(null);
        }}
      />
      <ApiKeyTransferDialog
        key={`transfer:${transferringApiKey?.id || "none"}`}
        apiKey={transferringApiKey}
        tenants={tenants}
        onOpenChange={(open) => {
          if (!open) {
            setTransferringApiKey(null);
          }
        }}
        onTransferred={(result) => {
          onTransferred(result);
          setTransferringApiKey(null);
        }}
      />
      <CreatedApiKeyDialog
        apiKey={createdKey}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
          }
        }}
      />
    </>
  );
}

function ApiKeyFormDialog({
  apiKey,
  channels,
  mode,
  onOpenChange,
  onSaved,
  open,
}: {
  apiKey?: PublicApiKey | null;
  channels: ChannelRecord[];
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
  open: boolean;
}) {
  const initialForm =
    mode === "edit" && apiKey ? apiKeyToForm(apiKey) : EMPTY_API_KEY_FORM;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {open && (
          <ApiKeyFormDialogBody
            key={`${mode}:${apiKey?.id || "new"}`}
            apiKey={apiKey}
            channels={channels}
            initialForm={initialForm}
            mode={mode}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onSaved(saved);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyFormDialogBody({
  apiKey,
  channels,
  initialForm,
  mode,
  onCancel,
  onSaved,
}: {
  apiKey?: PublicApiKey | null;
  channels: ChannelRecord[];
  initialForm: ApiKeyFormState;
  mode: "create" | "edit";
  onCancel: () => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
}) {
  const [form, setForm] = React.useState<ApiKeyFormState>(initialForm);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = apiKeyFormToPayload(form, {
        fallbackName: "Relay API 密钥",
      });
      const saved =
        mode === "create"
          ? await createApiKey(payload)
          : await updateApiKey(assertApiKey(apiKey).id, payload);
      onSaved(saved);
      toast.success(mode === "create" ? "API 密钥已创建" : "API 密钥已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {mode === "create" ? "新建 API 密钥" : "编辑 API 密钥"}
        </DialogTitle>
        <DialogDescription>
          完整密钥明文只会在创建成功后显示一次。编辑时不会重新生成明文密钥。
        </DialogDescription>
      </DialogHeader>
      <FieldSet>
        <FieldLegend>密钥配置</FieldLegend>
        <ApiKeyBaseFields
          form={form}
          onChange={setForm}
          channelSelector={
            <ChannelVisualSelector
              channels={channels}
              emptyLabel="不限通道"
              selectedIds={parseList(form.channelAllowlist)}
              onSelectedIdsChange={(ids) =>
                setForm((current) => ({
                  ...current,
                  channelAllowlist: ids.join("\n"),
                }))
              }
            />
          }
        />
      </FieldSet>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          {mode === "create" ? "创建密钥" : "保存配置"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ApiKeyTransferDialog({
  apiKey,
  onOpenChange,
  onTransferred,
  tenants,
}: {
  apiKey: PublicApiKey | null;
  tenants: PublicTenant[];
  onOpenChange: (open: boolean) => void;
  onTransferred: (result: ApiKeyTransferResponse) => void;
}) {
  const [tenantId, setTenantId] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const effectiveTenantId = tenantId || tenants[0]?.id || "";
  const selectedTenant =
    tenants.find((tenant) => tenant.id === effectiveTenantId) || null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey || !selectedTenant) {
      return;
    }
    setPending(true);
    try {
      const result = await transferApiKeyToTenant(apiKey.id, selectedTenant.id);
      onTransferred(result);
      toast.success(
        `API 密钥已转让给 ${result.tenant.name}，历史请求 ${formatNumber(
          result.migrated.requestLogs,
        )} 条已迁移`,
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>转让 API 密钥</DialogTitle>
            <DialogDescription>
              转让后这个 Key 会归入目标租户，历史请求和用量也会进入该租户统计。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>当前密钥</FieldLabel>
              <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                <div className="font-medium">{apiKey?.name || "-"}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {apiKey?.prefix || "-"}
                </div>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-transfer-tenant">
                目标租户
              </FieldLabel>
              <Select
                value={effectiveTenantId}
                onValueChange={(value) => setTenantId(value || "")}
              >
                <SelectTrigger
                  id="api-key-transfer-tenant"
                  className="w-full"
                >
                  <SelectValue placeholder="选择租户" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {tenants.map((tenant) => (
                      <SelectItem key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {selectedTenant && (
                <FieldDescription>
                  Owner：{formatTenantOwner(selectedTenant)} · 当前 Key{" "}
                  {formatNumber(selectedTenant.apiKeyCount)}
                  {selectedTenant.maxApiKeys === null
                    ? " / 不限制"
                    : ` / ${formatNumber(selectedTenant.maxApiKeys)}`}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || !selectedTenant}>
              {pending && <Spinner data-icon="inline-start" />}
              确认转让
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChannelVisualSelector({
  channels,
  emptyLabel,
  onSelectedIdsChange,
  selectedIds,
}: {
  channels: ChannelRecord[];
  emptyLabel: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const uniqueChannels = uniqueChannelsById(channels);
  const selectedIdSet = new Set(selectedIds);
  const unrestricted = selectedIds.length === 0;

  function toggleChannel(id: string) {
    onSelectedIdsChange(
      selectedIdSet.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  if (uniqueChannels.length === 0) {
    return (
      <Alert>
        <RouteIcon />
        <AlertTitle>暂无可选通道</AlertTitle>
        <AlertDescription>请先创建或导入通道。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant={unrestricted ? "secondary" : "outline"}
        className="h-auto justify-start p-3 text-left"
        onClick={() => onSelectedIdsChange([])}
      >
        <div className="flex min-w-0 items-center gap-2">
          {unrestricted ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
          ) : (
            <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div>
            <div className="font-medium">{emptyLabel}</div>
            <div className="text-xs text-muted-foreground">
              Relay 会在所有可用通道中自动路由。
            </div>
          </div>
        </div>
      </Button>

      <div className="grid gap-2 sm:grid-cols-2">
        {uniqueChannels.map((channel, index) => {
          const selected = selectedIdSet.has(channel.id);
          return (
            <Button
              key={`${channel.id}:${index}`}
              type="button"
              variant={selected ? "secondary" : "outline"}
              className="h-auto justify-start whitespace-normal p-3 text-left"
              onClick={() => toggleChannel(channel.id)}
            >
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {selected ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
                    ) : (
                      <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{channel.name}</span>
                  </div>
                  {renderChannelStatusBadge(channel.status)}
                </div>
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <div className="truncate font-mono">{channel.id}</div>
                  <div>
                    优先级 {formatNumber(channel.priority)} · 权重{" "}
                    {formatNumber(channel.weight)} · 凭据{" "}
                    {formatNumber(channel.credentialIds.length)} · 健康度{" "}
                    {formatNumber(channel.healthScore)}%
                  </div>
                </div>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function CreatedApiKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: CreatedApiKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>API 密钥只显示一次</DialogTitle>
          <DialogDescription>
            服务端只保存哈希。关闭后无法再次查看完整密钥，请立即复制保存。
          </DialogDescription>
        </DialogHeader>
        {apiKey && (
          <div className="grid gap-4">
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>{apiKey.name}</AlertTitle>
              <AlertDescription>
                后续列表只会显示前缀：{apiKey.prefix}。
              </AlertDescription>
            </Alert>
            <Field>
              <FieldLabel htmlFor="created-api-key">完整 API 密钥</FieldLabel>
              <Input id="created-api-key" readOnly value={apiKey.key} />
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => apiKey && copyText(apiKey.key)}
          >
            <CopyIcon data-icon="inline-start" />
            复制密钥
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyDeleteDialog({
  apiKey,
  disabled,
  onConfirm,
}: {
  apiKey: PublicApiKey;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" />
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除 API 密钥？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {apiKey.name}。使用这个密钥的客户端会立即无法访问 Relay。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function renderEnabledBadge(enabled: boolean) {
  return enabled ? (
    <WorkspaceStatusBadge tone="success" className="gap-1.5">
      <CheckCircle2Icon data-icon="inline-start" />
      on
    </WorkspaceStatusBadge>
  ) : (
    <WorkspaceStatusBadge tone="muted" className="gap-1.5">
      off
    </WorkspaceStatusBadge>
  );
}

function renderChannelStatusBadge(status: ChannelStatus) {
  if (status === "healthy") {
    return <WorkspaceStatusBadge tone="success">{STATUS_LABELS[status]}</WorkspaceStatusBadge>;
  }
  if (status === "degraded" || status === "cooling_down") {
    return <WorkspaceStatusBadge tone="warning">{STATUS_LABELS[status]}</WorkspaceStatusBadge>;
  }
  return <WorkspaceStatusBadge tone="danger">{STATUS_LABELS[status]}</WorkspaceStatusBadge>;
}

function renderStringList(values: string[], emptyLabel: string) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">{emptyLabel}</span>;
  }

  return (
    <div className="flex max-w-64 flex-wrap gap-1">
      {values.slice(0, 3).map((value, index) => (
        <Badge key={`${value}:${index}`} variant="outline">
          {value}
        </Badge>
      ))}
      {values.length > 3 && (
        <Badge variant="outline">+{values.length - 3}</Badge>
      )}
    </div>
  );
}

function uniqueChannelsById(channels: ChannelRecord[]) {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    if (seen.has(channel.id)) {
      return false;
    }
    seen.add(channel.id);
    return true;
  });
}

function activityHeatmapMarkdown(
  input: { apiKeyId?: string | null; label?: string; absolute?: boolean } = {},
) {
  const label = markdownAlt(input.label || "RelayAPI activity");
  return `![${label}](${activityHeatmapUrl(input)})`;
}

function activityHeatmapUrl(
  input: { apiKeyId?: string | null; absolute?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (input.apiKeyId) {
    params.set("key", input.apiKeyId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const path = `/api/activity.svg${suffix}`;
  return input.absolute ? `${clientOrigin()}${path}` : path;
}

function clientOrigin() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function markdownAlt(value: string) {
  return value.replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

function formatNullableDate(value: string | null) {
  return value ? formatDateTime(value) : <span className="text-muted-foreground">-</span>;
}

function formatTenantOwner(tenant: PublicTenant) {
  if (tenant.ownerEmail) {
    return tenant.ownerEmail;
  }
  return tenant.pendingInvite ? "Pending invite" : "未邀请";
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatScaledNumber(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatScaledNumber(value / 1_000_000)}M`;
  }
  if (absValue >= 1_000) {
    return `${formatScaledNumber(value / 1_000)}K`;
  }
  return formatNumber(value);
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}
