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
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import { formatDateTime } from "@/components/workspace/format";
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
import { ModelSelector, stripThinkingLevel } from "@/components/workspace/model-selector";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  createChannel,
  deleteChannel,
  updateChannel,
  type ChannelPayload,
} from "@/lib/admin-api";
import type {
  ChannelRecord,
  ChannelStatus,
  CodexCredentialRecord,
  GrokCredentialRecord,
  ProviderCredentialRecord,
} from "@/src/shared/types/entities";

type ChannelFormState = {
  provider: "codex" | "grok";
  name: string;
  credentialIds: string;
  enabled: boolean;
  baseUrl: string;
  priority: string;
  weight: string;
  modelAllowlist: string;
};

const EMPTY_CHANNEL_FORM: ChannelFormState = {
  provider: "codex",
  name: "",
  credentialIds: "",
  enabled: true,
  baseUrl: "",
  priority: "100",
  weight: "1",
  modelAllowlist: "",
};

const STATUS_LABELS: Record<ChannelStatus, string> = {
  healthy: "可用",
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
  const [grokCredentials, setGrokCredentials] = React.useState<GrokCredentialRecord[]>([]);
  React.useEffect(() => {
    let active = true;
    void fetch("/api/admin/grok/credentials").then(async (response) => {
      if (active && response.ok) setGrokCredentials(await response.json());
    });
    return () => { active = false; };
  }, []);
  const allCredentials: ProviderCredentialRecord[] = [...credentials, ...grokCredentials];
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingChannel, setEditingChannel] =
    React.useState<ChannelRecord | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const credentialsById = new Map(
    allCredentials.map((credential) => [credential.id, credential]),
  );
  const uniqueChannels = uniqueChannelsById(channels);

  async function toggleEnabled(channel: ChannelRecord, enabled: boolean) {
    setPendingId(channel.id);
    try {
      const updated = await updateChannel(channel.id, { enabled });
      onUpdated(updated);
      toast.success(enabled ? "路由池已启用" : "路由池已禁用");
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
      toast.success("路由池状态已重置");
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
      toast.success("路由池已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>路由池</CardTitle>
              <p className="text-sm text-muted-foreground">
                将一组凭据包装成稳定的授权与调度边界。
              </p>
            </div>
            <CardAction>
              <Button
                type="button"
                disabled={credentials.length === 0}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon data-icon="inline-start" />
                新建
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
                  <EmptyTitle>还没有路由池</EmptyTitle>
                  <EmptyDescription>添加凭据后创建路由池，再把池授权给租户或 API 密钥。</EmptyDescription>
                </EmptyHeader>
                <Button
                  type="button"
                  disabled={credentials.length === 0}
                  onClick={() => setCreateOpen(true)}
                >
                  <PlusIcon data-icon="inline-start" />
                  新建
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
                    <TableHead>采样分数</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uniqueChannels.map((channel, index) => {
                    const channelCredentials = channel.credentialIds
                      .map((credentialId) => credentialsById.get(credentialId))
                      .filter(Boolean) as ProviderCredentialRecord[];
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
                                    {credentialIdentity(credential)}
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
                          {renderStringList(channel.modelAllowlist, "未声明模型")}
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
        credentials={allCredentials}
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => onCreated(created)}
      />
      <ChannelFormDialog
        channel={editingChannel}
        credentials={allCredentials}
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
  credentials: ProviderCredentialRecord[];
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
          credentialIds: credentials.find((item) => item.provider === "codex")?.id || credentials[0]?.id || "",
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
  credentials: ProviderCredentialRecord[];
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
      toast.error(`请至少选择一个 ${form.provider === "grok" ? "Grok" : "Codex"} 凭据`);
      return;
    }
    if (parseList(form.modelAllowlist).length === 0) {
      toast.error("请至少声明一个可路由模型");
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
      toast.success(mode === "create" ? "路由池已创建" : "路由池已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "新建路由池" : "编辑路由池"}</DialogTitle>
        <DialogDescription>
          路由池由凭据集合、模型范围和调度策略组成。请求先匹配一个池，再由池选择实际凭据。
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
          {mode === "create" ? "创建路由池" : "保存路由池"}
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
  credentials: ProviderCredentialRecord[];
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
      <FieldLegend>路由池配置</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel>服务商</FieldLabel>
          <Select value={form.provider} onValueChange={(value) => onChange((current) => ({ ...current, provider: value === "grok" ? "grok" : "codex", credentialIds: "", modelAllowlist: "" }))}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="codex">Codex</SelectItem><SelectItem value="grok">Grok</SelectItem></SelectGroup></SelectContent>
          </Select>
          <FieldDescription>一个路由池只绑定同一服务商的凭据。</FieldDescription>
        </Field>
        {credentials.length === 0 && (
          <Alert>
            <UserRoundIcon />
            <AlertTitle>需要先连接 Codex 凭据</AlertTitle>
            <AlertDescription>
              创建路由池前必须至少有一个 Codex 凭据。
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
            credentials={credentials.filter((credential) => credential.provider === form.provider)}
            selectedIds={parseList(form.credentialIds)}
            onSelectedIdsChange={(ids) =>
              update("credentialIds", ids.join("\n"))
            }
          />
          <FieldDescription>
            池内可放入多个凭据，并按凭据优先级、权重和采样分数选择实际出口；租户只需绑定路由池，无需感知凭据变化。
          </FieldDescription>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="channel-enabled">启用路由池</FieldLabel>
            <FieldDescription>
              关闭后这个池不会参与自动路由，已有授权无需修改。
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
          <FieldLabel>模型白名单</FieldLabel>
          <ModelSelector key={form.provider} catalogProvider={form.provider} selectedModels={parseList(form.modelAllowlist)} onSelectedModelsChange={(models) => update("modelAllowlist", models.join("\n"))} />
          <FieldDescription>请求只会进入明确声明了对应模型的路由池。</FieldDescription>
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
  credentials: ProviderCredentialRecord[];
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
        const name = credentialIdentity(credential);
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
                  {credential.provider === "grok" ? "Grok" : codexPlanLabel(credential.planType)}
                </Badge>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div className="truncate font-mono">{credential.id}</div>
                <div>
                  优先级 {formatNumber(credential.priority)} · 权重{" "}
                  {formatNumber(credential.weight)} · 采样分数{" "}
                  {formatNumber(credential.provider === "codex" ? usageHealthScore(credential.usageHealth) : 100)}%
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
          <AlertDialogTitle>删除路由池？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {channel.name}。关联租户与 API 密钥将不再能通过这个池路由。
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
    provider: channel.provider,
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
    provider: form.provider,
    name: form.name.trim(),
    credentialId: credentialIds[0],
    credentialIds,
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    priority: integerValue(form.priority, 100),
    weight: Math.max(1, integerValue(form.weight, 1)),
    modelAllowlist: [...new Set(parseList(form.modelAllowlist).map(stripThinkingLevel).filter(Boolean))],
  };
}

function assertChannel(channel: ChannelRecord | null | undefined) {
  if (!channel) {
    throw new Error("缺少路由池");
  }
  return channel;
}

function renderChannelStatusBadge(status: ChannelStatus) {
  if (status === "healthy") {
    return (
      <WorkspaceStatusBadge tone="success">
        {STATUS_LABELS[status]}
      </WorkspaceStatusBadge>
    );
  }
  if (status === "degraded" || status === "cooling_down") {
    return (
      <WorkspaceStatusBadge tone="warning">
        {STATUS_LABELS[status]}
      </WorkspaceStatusBadge>
    );
  }
  return (
    <WorkspaceStatusBadge tone="danger">
      {STATUS_LABELS[status]}
    </WorkspaceStatusBadge>
  );
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
  return formatDateTime(value);
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
function credentialIdentity(credential: ProviderCredentialRecord) { return credential.email || (credential.provider === "codex" ? credential.accountId : credential.subject) || credential.id; }
