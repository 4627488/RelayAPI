"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RouteIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";

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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { Textarea } from "@/components/ui/textarea";
import {
  adminErrorMessage,
  createChannel,
  deleteChannel,
  updateChannel,
  type ChannelPayload,
} from "@/lib/admin-api";
import type {
  ChannelRecord,
  ChannelStatus,
  CodexCredentialRecord,
} from "@/src/shared/types/entities";

type ChannelFormState = {
  name: string;
  credentialIds: string;
  enabled: boolean;
  baseUrl: string;
  priority: string;
  weight: string;
  modelAllowlist: string;
};

const EMPTY_CHANNEL_FORM: ChannelFormState = {
  name: "",
  credentialIds: "",
  enabled: true,
  baseUrl: "",
  priority: "100",
  weight: "1",
  modelAllowlist: "",
};

const STATUS_LABELS: Record<ChannelStatus, string> = {
  healthy: "健康",
  degraded: "降级",
  cooling_down: "冷却中",
  disabled: "已禁用",
};

export function ChannelsSection({
  channels,
  credentials,
  onCreated,
  onDeleted,
  onUpdated,
}: {
  channels: ChannelRecord[];
  credentials: CodexCredentialRecord[];
  onCreated: (channel: ChannelRecord) => void;
  onDeleted: (id: string) => void;
  onUpdated: (channel: ChannelRecord) => void;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingChannel, setEditingChannel] =
    React.useState<ChannelRecord | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const credentialsById = new Map(
    credentials.map((credential) => [credential.id, credential]),
  );
  const uniqueChannels = uniqueChannelsById(channels);

  async function toggleEnabled(channel: ChannelRecord, enabled: boolean) {
    setPendingId(channel.id);
    try {
      const updated = await updateChannel(channel.id, { enabled });
      onUpdated(updated);
      toast.success(enabled ? "通道已启用" : "通道已禁用");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function recover(channel: ChannelRecord) {
    setPendingId(channel.id);
    try {
      const updated = await updateChannel(channel.id, {
        status: "healthy",
        healthScore: 100,
        cooldownUntil: null,
      });
      onUpdated(updated);
      toast.success("通道已恢复健康");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function remove(channel: ChannelRecord) {
    setPendingId(channel.id);
    try {
      await deleteChannel(channel.id);
      onDeleted(channel.id);
      toast.success("通道已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <div className="grid gap-4">
        <Alert>
          <RouteIcon />
          <AlertTitle>自动路由规则</AlertTitle>
          <AlertDescription>
            Relay
            会先过滤已禁用、冷却中、凭据缺失和模型不匹配的通道；通道健康度取最近
            100 次请求成功率，凭据健康度取最近 50
            次请求成功率。路由先按健康度分层，再按优先级和权重加权选择。
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>通道</CardTitle>
            <CardDescription>
              配置自动路由单元、优先级、权重、健康状态与模型白名单。
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                disabled={credentials.length === 0}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon data-icon="inline-start" />
                新建通道
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {uniqueChannels.length === 0 ? (
              <Empty className="min-h-64">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <RouteIcon />
                  </EmptyMedia>
                  <EmptyTitle>还没有通道</EmptyTitle>
                  <EmptyDescription>
                    添加 Codex
                    凭据后通常会自动创建默认通道，也可以手动创建多个通道做优先级和权重路由。
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  type="button"
                  disabled={credentials.length === 0}
                  onClick={() => setCreateOpen(true)}
                >
                  <PlusIcon data-icon="inline-start" />
                  新建通道
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>凭据</TableHead>
                    <TableHead>优先级</TableHead>
                    <TableHead>权重</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>健康度</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uniqueChannels.map((channel, index) => {
                    const channelCredentials = channel.credentialIds
                      .map((credentialId) => credentialsById.get(credentialId))
                      .filter(Boolean) as CodexCredentialRecord[];
                    return (
                      <TableRow key={`${channel.id}:${index}`}>
                        <TableCell>
                          <div className="font-medium">{channel.name}</div>
                          <div className="max-w-80 truncate text-xs text-muted-foreground">
                            {channel.baseUrl}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            最后使用 {formatNullableDate(channel.lastUsedAt)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={channel.enabled}
                              disabled={pendingId === channel.id}
                              size="sm"
                              onCheckedChange={(checked) =>
                                toggleEnabled(channel, Boolean(checked))
                              }
                            />
                            {renderChannelStatusBadge(channel.status)}
                          </div>
                          {channel.cooldownUntil && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              冷却至 {formatNullableDate(channel.cooldownUntil)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {channelCredentials.length > 0 ? (
                            <div className="grid gap-1">
                              {channelCredentials
                                .slice(0, 2)
                                .map((credential, index) => (
                                  <div
                                    key={`${credential.id}:${index}`}
                                    className="truncate"
                                  >
                                    {credential.email ||
                                      credential.accountId ||
                                      credential.id}
                                  </div>
                                ))}
                              {channelCredentials.length > 2 && (
                                <div className="text-xs text-muted-foreground">
                                  +{formatNumber(channelCredentials.length - 2)}{" "}
                                  个凭据
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">未知</span>
                          )}
                        </TableCell>
                        <TableCell>{formatNumber(channel.priority)}</TableCell>
                        <TableCell>{formatNumber(channel.weight)}</TableCell>
                        <TableCell>
                          {renderStringList(channel.modelAllowlist, "全部模型")}
                        </TableCell>
                        <TableCell>
                          <div className="min-w-28 space-y-1">
                            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                              <span>
                                最近{" "}
                                {formatNumber(
                                  channel.usageHealth?.windowSize || 100,
                                )}{" "}
                                次
                              </span>
                              <span className="tabular-nums">
                                {formatNumber(channel.healthScore)}%
                              </span>
                            </div>
                            <Progress
                              value={clamp(channel.healthScore, 0, 100)}
                            />
                            {channel.usageHealth && (
                              <div className="text-xs text-muted-foreground">
                                成功{" "}
                                {formatNumber(channel.usageHealth.successCount)}{" "}
                                · 错误{" "}
                                {formatNumber(channel.usageHealth.errorCount)}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={pendingId === channel.id}
                              onClick={() => recover(channel)}
                            >
                              <RefreshCwIcon data-icon="inline-start" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingChannel(channel)}
                            >
                              <PencilIcon data-icon="inline-start" />
                            </Button>
                            <ChannelDeleteDialog
                              channel={channel}
                              disabled={pendingId === channel.id}
                              onConfirm={() => remove(channel)}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ChannelFormDialog
        credentials={credentials}
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => onCreated(created)}
      />
      <ChannelFormDialog
        channel={editingChannel}
        credentials={credentials}
        mode="edit"
        open={Boolean(editingChannel)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingChannel(null);
          }
        }}
        onSaved={(updated) => {
          onUpdated(updated);
          setEditingChannel(null);
        }}
      />
    </>
  );
}

function ChannelFormDialog({
  channel,
  credentials,
  mode,
  onOpenChange,
  onSaved,
  open,
}: {
  channel?: ChannelRecord | null;
  credentials: CodexCredentialRecord[];
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (channel: ChannelRecord) => void;
  open: boolean;
}) {
  const initialForm =
    mode === "edit" && channel
      ? channelToForm(channel)
      : {
          ...EMPTY_CHANNEL_FORM,
          credentialIds: credentials[0]?.id || "",
        };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        {open && (
          <ChannelFormDialogBody
            key={`${mode}:${channel?.id || credentials[0]?.id || "new"}`}
            channel={channel}
            credentials={credentials}
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

function ChannelFormDialogBody({
  channel,
  credentials,
  initialForm,
  mode,
  onCancel,
  onSaved,
}: {
  channel?: ChannelRecord | null;
  credentials: CodexCredentialRecord[];
  initialForm: ChannelFormState;
  mode: "create" | "edit";
  onCancel: () => void;
  onSaved: (channel: ChannelRecord) => void;
}) {
  const [form, setForm] = React.useState(initialForm);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parseList(form.credentialIds).length === 0) {
      toast.error("请至少选择一个 Codex 凭据");
      return;
    }
    setPending(true);
    try {
      const payload = channelFormToPayload(form);
      const saved =
        mode === "create"
          ? await createChannel(payload)
          : await updateChannel(assertChannel(channel).id, payload);
      onSaved(saved);
      toast.success(mode === "create" ? "通道已创建" : "通道已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "新建通道" : "编辑通道"}</DialogTitle>
        <DialogDescription>
          通道是自动路由单元。优先级越高越优先，同优先级下按权重加权选择。
        </DialogDescription>
      </DialogHeader>
      <ChannelFields credentials={credentials} form={form} onChange={setForm} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={pending || credentials.length === 0}>
          {pending && <Spinner data-icon="inline-start" />}
          {mode === "create" ? "创建通道" : "保存通道"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ChannelFields({
  credentials,
  form,
  onChange,
}: {
  credentials: CodexCredentialRecord[];
  form: ChannelFormState;
  onChange: React.Dispatch<React.SetStateAction<ChannelFormState>>;
}) {
  const update = <K extends keyof ChannelFormState>(
    key: K,
    value: ChannelFormState[K],
  ) => {
    onChange((current) => ({ ...current, [key]: value }));
  };

  return (
    <FieldSet>
      <FieldLegend>通道配置</FieldLegend>
      <FieldGroup>
        {credentials.length === 0 && (
          <Alert>
            <UserRoundIcon />
            <AlertTitle>需要先连接 Codex 凭据</AlertTitle>
            <AlertDescription>
              创建通道前必须至少有一个 Codex 凭据。
            </AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel htmlFor="channel-name">名称</FieldLabel>
          <Input
            id="channel-name"
            value={form.name}
            placeholder="Codex · account@example.com"
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel>绑定凭据</FieldLabel>
          <CredentialVisualSelector
            credentials={credentials}
            selectedIds={parseList(form.credentialIds)}
            onSelectedIdsChange={(ids) =>
              update("credentialIds", ids.join("\n"))
            }
          />
          <FieldDescription>
            可选择多个凭据。通道内会按凭据优先级、权重和健康度自动选择实际发送请求的凭据。
          </FieldDescription>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="channel-enabled">启用通道</FieldLabel>
            <FieldDescription>
              关闭后这个通道不会参与自动路由。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="channel-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => update("enabled", Boolean(checked))}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="channel-base-url">上游基础 URL</FieldLabel>
          <Input
            id="channel-base-url"
            value={form.baseUrl}
            placeholder="留空使用服务端默认 Codex 基础 URL"
            onChange={(event) => update("baseUrl", event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="channel-priority">优先级</FieldLabel>
            <Input
              id="channel-priority"
              inputMode="numeric"
              value={form.priority}
              onChange={(event) => update("priority", event.target.value)}
            />
            <FieldDescription>数值越高越优先。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="channel-weight">权重</FieldLabel>
            <Input
              id="channel-weight"
              inputMode="numeric"
              value={form.weight}
              onChange={(event) => update("weight", event.target.value)}
            />
            <FieldDescription>同优先级下按权重选择。</FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="channel-models">模型白名单</FieldLabel>
          <Textarea
            id="channel-models"
            className="min-h-24"
            value={form.modelAllowlist}
            placeholder="留空表示不限模型，例如 gpt-5.5 或 gpt-5.5(xhigh)"
            onChange={(event) => update("modelAllowlist", event.target.value)}
          />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

function CredentialVisualSelector({
  credentials,
  onSelectedIdsChange,
  selectedIds,
}: {
  credentials: CodexCredentialRecord[];
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const selectedIdSet = new Set(selectedIds);

  function toggleCredential(id: string) {
    onSelectedIdsChange(
      selectedIdSet.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  if (credentials.length === 0) {
    return (
      <Alert>
        <UserRoundIcon />
        <AlertTitle>暂无可选凭据</AlertTitle>
        <AlertDescription>请先连接或上传 Codex 凭据。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {credentials.map((credential) => {
        const selected = selectedIdSet.has(credential.id);
        const name = credential.email || credential.accountId || credential.id;
        return (
          <Button
            key={credential.id}
            type="button"
            variant={selected ? "secondary" : "outline"}
            className="h-auto justify-start whitespace-normal p-3 text-left"
            onClick={() => toggleCredential(credential.id)}
          >
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {selected ? (
                    <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
                  ) : (
                    <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-medium">{name}</span>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {codexPlanLabel(credential.planType)}
                </Badge>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div className="truncate font-mono">{credential.id}</div>
                <div>
                  优先级 {formatNumber(credential.priority)} · 权重{" "}
                  {formatNumber(credential.weight)} · 健康度{" "}
                  {formatNumber(usageHealthScore(credential.usageHealth))}%
                </div>
              </div>
            </div>
          </Button>
        );
      })}
    </div>
  );
}

function ChannelDeleteDialog({
  channel,
  disabled,
  onConfirm,
}: {
  channel: ChannelRecord;
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
          <AlertDialogTitle>删除通道？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {channel.name}。自动路由将不再选择这个通道。
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

function channelToForm(channel: ChannelRecord): ChannelFormState {
  return {
    name: channel.name,
    credentialIds: channel.credentialIds.join("\n"),
    enabled: channel.enabled,
    baseUrl: channel.baseUrl,
    priority: channel.priority.toString(),
    weight: channel.weight.toString(),
    modelAllowlist: channel.modelAllowlist.join("\n"),
  };
}

function channelFormToPayload(form: ChannelFormState): ChannelPayload {
  const credentialIds = parseList(form.credentialIds);
  return {
    name: form.name.trim(),
    credentialId: credentialIds[0],
    credentialIds,
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    priority: integerValue(form.priority, 100),
    weight: Math.max(1, integerValue(form.weight, 1)),
    modelAllowlist: parseList(form.modelAllowlist),
  };
}

function assertChannel(channel: ChannelRecord | null | undefined) {
  if (!channel) {
    throw new Error("缺少通道");
  }
  return channel;
}

function renderChannelStatusBadge(status: ChannelStatus) {
  if (status === "healthy") {
    return <Badge variant="secondary">{STATUS_LABELS[status]}</Badge>;
  }
  if (status === "degraded" || status === "cooling_down") {
    return <Badge variant="outline">{STATUS_LABELS[status]}</Badge>;
  }
  return <Badge variant="destructive">{STATUS_LABELS[status]}</Badge>;
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

function parseList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function integerValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatNullableDate(value: string | null) {
  if (!value) {
    return <span className="text-muted-foreground">-</span>;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function codexPlanLabel(planType: string) {
  const normalized = planType.trim().toLowerCase();
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro 20x",
    prolite: "Pro 5x",
    "pro-lite": "Pro 5x",
    pro_lite: "Pro 5x",
    team: "Team",
  };
  return labels[normalized] || planType || "未知";
}

function usageHealthScore(health: CodexCredentialRecord["usageHealth"]) {
  return clamp(health?.score ?? 100, 0, 100);
}
