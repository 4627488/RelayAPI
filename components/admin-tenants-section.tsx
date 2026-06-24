"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
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
  createTenant,
  createTenantInvite,
  deleteTenant,
  updateTenant,
  type TenantPayload,
} from "@/lib/admin-api";
import type { CreatedTenantInvite, PublicTenant } from "@/src/shared/types/entities";

type TenantFormState = {
  name: string;
  ownerEmail: string;
  enabled: boolean;
  maxApiKeys: string;
  tokenLimitDaily: string;
  rateLimitPerMinute: string;
  modelAllowlist: string;
  channelAllowlist: string;
  allowCustomProxy: boolean;
  allowCustomUserAgent: boolean;
  userAgent: string;
  expiresAt: string;
};

const EMPTY_TENANT_FORM: TenantFormState = {
  name: "",
  ownerEmail: "",
  enabled: true,
  maxApiKeys: "",
  tokenLimitDaily: "",
  rateLimitPerMinute: "",
  modelAllowlist: "",
  channelAllowlist: "",
  allowCustomProxy: false,
  allowCustomUserAgent: false,
  userAgent: "",
  expiresAt: "",
};

export function AdminTenantsSection({
  onChanged,
  tenants,
}: {
  tenants: PublicTenant[];
  onChanged: (tenants: PublicTenant[]) => void;
}) {
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicTenant | null>(null);
  const [pendingInvite, setPendingInvite] =
    React.useState<CreatedTenantInvite | null>(null);

  async function removeTenant(id: string) {
    if (!window.confirm("确认删除这个租户？该操作会禁用租户并保留历史日志。")) {
      return;
    }
    try {
      await deleteTenant(id);
      onChanged(tenants.filter((tenant) => tenant.id !== id));
      toast.success("租户已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    }
  }

  async function inviteTenant(id: string) {
    try {
      const invite = await createTenantInvite(id);
      setPendingInvite(invite);
      onChanged(
        tenants.map((tenant) =>
          tenant.id === id ? { ...tenant, pendingInvite: true } : tenant,
        ),
      );
      toast.success("邀请链接已生成");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>租户</CardTitle>
          </div>
          <Button type="button" onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            新建
          </Button>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无租户</EmptyTitle>
                <EmptyDescription>创建后分配 Key 总池。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>租户</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>今日 Token</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id}>
                    <TableCell>
                      <div className="font-medium">{tenant.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {tenant.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      {tenant.ownerEmail ? (
                        tenant.ownerEmail
                      ) : tenant.pendingInvite ? (
                        <WorkspaceStatusBadge tone="warning">
                          invite
                        </WorkspaceStatusBadge>
                      ) : (
                        <span className="text-muted-foreground">未邀请</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {formatNumber(tenant.apiKeyCount)}
                      {tenant.maxApiKeys === null
                        ? " / 不限制"
                        : ` / ${formatNumber(tenant.maxApiKeys)}`}
                    </TableCell>
                    <TableCell>
                      {formatTokenNumber(tenant.todayTokens)}
                      {tenant.tokenLimitDaily === null
                        ? " / 不限制"
                        : ` / ${formatTokenNumber(tenant.tokenLimitDaily)}`}
                    </TableCell>
                    <TableCell>
                      <WorkspaceStatusBadge tone={tenant.enabled ? "success" : "muted"}>
                        {tenant.enabled ? "on" : "off"}
                      </WorkspaceStatusBadge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="生成邀请链接"
                          disabled={Boolean(
                            tenant.ownerEmail || tenant.pendingInvite,
                          )}
                          onClick={() => inviteTenant(tenant.id)}
                        >
                          <LinkIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="编辑租户"
                          onClick={() => setEditing(tenant)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="删除租户"
                          onClick={() => removeTenant(tenant.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TenantFormDialog
        key={`create:${creating ? "open" : "closed"}`}
        mode="create"
        open={creating}
        onOpenChange={setCreating}
        onSaved={async (tenant) => {
          const invite = await createTenantInvite(tenant.id);
          setPendingInvite(invite);
          onChanged([{ ...tenant, pendingInvite: true }, ...tenants]);
          toast.success("邀请链接已生成");
        }}
      />
      <TenantFormDialog
        key={`edit:${editing?.id || "none"}`}
        mode="edit"
        open={Boolean(editing)}
        tenant={editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
          }
        }}
        onSaved={(tenant) => {
          onChanged(
            tenants.map((item) => (item.id === tenant.id ? tenant : item)),
          );
          setEditing(null);
        }}
      />
      <InviteDialog
        invite={pendingInvite}
        onOpenChange={(open) => {
          if (!open) {
            setPendingInvite(null);
          }
        }}
      />
    </>
  );
}

function TenantFormDialog({
  mode,
  onOpenChange,
  onSaved,
  open,
  tenant,
}: {
  mode: "create" | "edit";
  open: boolean;
  tenant?: PublicTenant | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (tenant: PublicTenant) => void | Promise<void>;
}) {
  const [form, setForm] = React.useState<TenantFormState>(() =>
    tenant ? tenantToForm(tenant) : EMPTY_TENANT_FORM,
  );
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = tenantFormToPayload(form);
      const saved =
        mode === "create"
          ? await createTenant(payload)
          : await updateTenant(assertTenant(tenant).id, payload);
      await onSaved(saved);
      onOpenChange(false);
      toast.success(mode === "create" ? "租户已创建" : "租户已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "新建租户" : "编辑租户"}
            </DialogTitle>
            <DialogDescription>
              租户创建后会生成邀请链接，用户注册时填写姓名、邮箱和密码。
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend>基础信息</FieldLegend>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="tenant-name">租户名称</FieldLabel>
                <Input
                  id="tenant-name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              {mode === "edit" && (
                <Field>
                  <FieldLabel htmlFor="tenant-owner-email">
                    Owner 邮箱
                  </FieldLabel>
                  <Input
                    id="tenant-owner-email"
                    type="email"
                    value={form.ownerEmail}
                    placeholder="Pending invite"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        ownerEmail: event.target.value,
                      }))
                    }
                  />
                  <FieldDescription>
                    未注册前保持为空，用户接受邀请后会自动写入。
                  </FieldDescription>
                </Field>
              )}
              <Field orientation="horizontal">
                <div>
                  <FieldLabel htmlFor="tenant-enabled">启用租户</FieldLabel>
                  <FieldDescription>
                    停用后，该租户所有 Key 和面板会立即不可用。
                  </FieldDescription>
                </div>
                <Switch
                  id="tenant-enabled"
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      enabled: Boolean(checked),
                    }))
                  }
                />
              </Field>
            </FieldGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend>限制</FieldLegend>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="tenant-max-keys">Key 数上限</FieldLabel>
                  <Input
                    id="tenant-max-keys"
                    inputMode="numeric"
                    value={form.maxApiKeys}
                    placeholder="不限制"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        maxApiKeys: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tenant-token-limit">
                    每日 token
                  </FieldLabel>
                  <Input
                    id="tenant-token-limit"
                    inputMode="numeric"
                    value={form.tokenLimitDaily}
                    placeholder="不限制"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        tokenLimitDaily: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tenant-rate-limit">
                    每分钟请求
                  </FieldLabel>
                  <Input
                    id="tenant-rate-limit"
                    inputMode="numeric"
                    value={form.rateLimitPerMinute}
                    placeholder="不限制"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        rateLimitPerMinute: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="tenant-expires-at">过期时间</FieldLabel>
                <Input
                  id="tenant-expires-at"
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      expiresAt: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-models">模型白名单</FieldLabel>
                <Textarea
                  id="tenant-models"
                  value={form.modelAllowlist}
                  placeholder="留空表示不限制模型"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      modelAllowlist: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-channels">通道白名单</FieldLabel>
                <Textarea
                  id="tenant-channels"
                  value={form.channelAllowlist}
                  placeholder="留空表示不限制通道；填写 channel id，每行一个"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      channelAllowlist: event.target.value,
                    }))
                  }
                />
              </Field>
            </FieldGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend>租户设置权限</FieldLegend>
            <FieldGroup>
              <Field orientation="horizontal">
                <div>
                  <FieldLabel htmlFor="tenant-custom-proxy">
                    允许租户配置代理
                  </FieldLabel>
                  <FieldDescription>
                    开启后，租户可保存自己的 SOCKS 代理。
                  </FieldDescription>
                </div>
                <Switch
                  id="tenant-custom-proxy"
                  checked={form.allowCustomProxy}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      allowCustomProxy: Boolean(checked),
                    }))
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <div>
                  <FieldLabel htmlFor="tenant-custom-ua">
                    允许租户配置 User-Agent
                  </FieldLabel>
                  <FieldDescription>
                    上游请求优先使用凭据级设置，其次使用租户设置。
                  </FieldDescription>
                </div>
                <Switch
                  id="tenant-custom-ua"
                  checked={form.allowCustomUserAgent}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      allowCustomUserAgent: Boolean(checked),
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-user-agent">默认 User-Agent</FieldLabel>
                <Input
                  id="tenant-user-agent"
                  value={form.userAgent}
                  placeholder="留空使用全局设置"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      userAgent: event.target.value,
                    }))
                  }
                />
              </Field>
            </FieldGroup>
          </FieldSet>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {mode === "create" ? "创建租户" : "保存租户"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  invite,
  onOpenChange,
}: {
  invite: CreatedTenantInvite | null;
  onOpenChange: (open: boolean) => void;
}) {
  async function copyInvite() {
    if (!invite) {
      return;
    }
    await navigator.clipboard.writeText(invite.activateUrl);
    toast.success("邀请链接已复制");
  }

  return (
    <Dialog open={Boolean(invite)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>租户邀请链接</DialogTitle>
          <DialogDescription>
            该链接一次性有效，用户打开后填写姓名、邮箱和密码完成注册。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/50 p-3 text-sm break-all">
          {invite?.activateUrl}
        </div>
        <p className="text-sm text-muted-foreground">
          过期时间：{formatDateTime(invite?.expiresAt || null)}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copyInvite}>
            <CopyIcon data-icon="inline-start" />
            复制链接
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function tenantToForm(tenant: PublicTenant): TenantFormState {
  return {
    name: tenant.name,
    ownerEmail: tenant.ownerEmail,
    enabled: tenant.enabled,
    maxApiKeys: tenant.maxApiKeys?.toString() || "",
    tokenLimitDaily: tenant.tokenLimitDaily?.toString() || "",
    rateLimitPerMinute: tenant.rateLimitPerMinute?.toString() || "",
    modelAllowlist: tenant.modelAllowlist.join("\n"),
    channelAllowlist: tenant.channelAllowlist.join("\n"),
    allowCustomProxy: tenant.allowCustomProxy,
    allowCustomUserAgent: tenant.allowCustomUserAgent,
    userAgent: tenant.userAgent || "",
    expiresAt: toDatetimeLocal(tenant.expiresAt),
  };
}

function tenantFormToPayload(form: TenantFormState): TenantPayload {
  return {
    name: form.name.trim(),
    ownerEmail: form.ownerEmail.trim(),
    enabled: form.enabled,
    maxApiKeys: nullablePositiveInteger(form.maxApiKeys),
    tokenLimitDaily: nullablePositiveInteger(form.tokenLimitDaily),
    rateLimitPerMinute: nullablePositiveInteger(form.rateLimitPerMinute),
    modelAllowlist: parseList(form.modelAllowlist),
    channelAllowlist: parseList(form.channelAllowlist),
    allowCustomProxy: form.allowCustomProxy,
    allowCustomUserAgent: form.allowCustomUserAgent,
    userAgent: form.userAgent.trim() || null,
    expiresAt: datetimeLocalToIso(form.expiresAt),
  };
}

function assertTenant(tenant: PublicTenant | null | undefined) {
  if (!tenant) {
    throw new Error("Tenant is required");
  }
  return tenant;
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

function nullablePositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function datetimeLocalToIso(value: string) {
  if (!value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDatetimeLocal(value: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatTokenNumber(value: number) {
  if (value >= 1_000_000) {
    return `${Math.round(value / 10_000) / 100}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return formatNumber(value);
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "未记录";
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
