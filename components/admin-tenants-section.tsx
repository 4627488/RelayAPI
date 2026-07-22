"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  LinkIcon,
  KeyRoundIcon,
  LogOutIcon,
  PencilIcon,
  PackagePlusIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import {
  datetimeLocalToIso,
  formatDateTime,
  toDatetimeLocal,
} from "@/components/workspace/format";
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
import { ModelSelector, stripThinkingLevel } from "@/components/workspace/model-selector";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  adminErrorMessage,
  createTenant,
  createTenantInvite,
  createTenantPasswordReset,
  createTenantSubscription,
  deleteTenantSubscription,
  getSubscriptionAllocationOverview,
  listTenantSubscriptions,
  deleteTenant,
  revokeTenantSessions,
  updateTenant,
  type TenantPayload,
  type SubscriptionCapacityPool,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import type { CreatedTenantInvite, PublicTenant } from "@/src/shared/types/entities";
import { providerPlanLabel } from "@/src/shared/providerCapabilities";

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
  publicBaseUrl,
  tenants,
}: {
  tenants: PublicTenant[];
  onChanged: (tenants: PublicTenant[]) => void;
  publicBaseUrl: string;
}) {
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicTenant | null>(null);
  const [pendingInvite, setPendingInvite] =
    React.useState<CreatedTenantInvite | null>(null);
  const [passwordReset, setPasswordReset] = React.useState<{ url: string; expiresAt: string } | null>(null);
  const [subscriptionTenant, setSubscriptionTenant] = React.useState<PublicTenant | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<TenantSubscriptionRecord[]>([]);

  React.useEffect(() => {
    void listTenantSubscriptions()
      .then(setSubscriptions)
      .catch((error) => toast.error(adminErrorMessage(error)));
  }, []);

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

  async function resetPassword(id: string) {
    try {
      const result = await createTenantPasswordReset(id);
      const base = publicBaseUrl || window.location.origin;
      setPasswordReset({ url: `${base.replace(/\/$/, "")}${result.resetPath}`, expiresAt: result.expiresAt });
      toast.success("密码重置链接已生成");
    } catch (error) { toast.error(adminErrorMessage(error)); }
  }

  async function revokeSessions(id: string) {
    if (!window.confirm("让该租户的所有已登录设备立即退出？")) return;
    try { await revokeTenantSessions(id); toast.success("租户会话已全部失效"); }
    catch (error) { toast.error(adminErrorMessage(error)); }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>租户</CardTitle>
            <p className="text-sm text-muted-foreground">
              集中查看订阅容量、Key 活跃度、今日消耗和账号生命周期。
            </p>
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
                  <TableHead>租户与账号</TableHead>
                  <TableHead>子订阅</TableHead>
                  <TableHead>API Key</TableHead>
                  <TableHead>今日消耗</TableHead>
                  <TableHead>访问策略</TableHead>
                  <TableHead>生命周期</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => {
                  const tenantSubscriptions = subscriptions.filter((item) => item.tenantId === tenant.id);
                  const activeSubscriptions = tenantSubscriptions.filter((item) => item.enabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
                  const tokenPercent = tenant.tokenLimitDaily ? Math.min(100, tenant.todayTokens / tenant.tokenLimitDaily * 100) : null;
                  return <TableRow key={tenant.id}>
                    <TableCell>
                      <div className="flex min-w-48 flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{tenant.name}</span>
                          <WorkspaceStatusBadge tone={tenant.enabled ? "success" : "muted"}>
                            {tenant.enabled ? "启用" : "停用"}
                          </WorkspaceStatusBadge>
                          {!tenant.ownerEmail && <WorkspaceStatusBadge tone={tenant.pendingInvite ? "warning" : "muted"}>{tenant.pendingInvite ? "待注册" : "未邀请"}</WorkspaceStatusBadge>}
                        </div>
                        <span className="truncate text-sm">{tenant.ownerEmail || "尚未绑定 Owner"}</span>
                        <span className="font-mono text-xs text-muted-foreground">{tenant.id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-36 flex-col gap-1.5">
                        <div className="flex items-center gap-2"><span className="text-lg font-semibold tabular-nums">{activeSubscriptions.length}</span><span className="text-xs text-muted-foreground">个可用</span></div>
                        <div className="flex flex-wrap gap-1">{activeSubscriptions.length ? activeSubscriptions.slice(0, 3).map((item) => <Badge key={item.id} variant="outline">{item.units}/{item.unitsPerCredential}</Badge>) : <span className="text-xs text-muted-foreground">未分配容量</span>}{activeSubscriptions.length > 3 && <Badge variant="secondary">+{activeSubscriptions.length - 3}</Badge>}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-28 flex-col gap-1"><span><strong className="tabular-nums">{formatNumber(tenant.enabledApiKeyCount)}</strong><span className="text-muted-foreground"> / {formatNumber(tenant.apiKeyCount)} 启用</span></span><span className="text-xs text-muted-foreground">上限 {tenant.maxApiKeys === null ? "不限" : formatNumber(tenant.maxApiKeys)}</span></div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-32 flex-col gap-1"><span className="font-medium tabular-nums">{formatTokenNumber(tenant.todayTokens)}</span><span className="text-xs text-muted-foreground">{tenant.tokenLimitDaily === null ? "未设置日限额" : `${Math.round(tokenPercent || 0)}% / ${formatTokenNumber(tenant.tokenLimitDaily)}`}</span></div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-36 flex-col gap-1 text-xs"><span>RPM {tenant.rateLimitPerMinute === null ? "不限" : formatNumber(tenant.rateLimitPerMinute)}</span><span className="text-muted-foreground">模型 {tenant.modelAllowlist.length || "全部"} · 通道 {tenant.channelAllowlist.length || "全部"}</span><span className="text-muted-foreground">自定义代理 {tenant.allowCustomProxy ? "允许" : "关闭"}</span></div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-40 flex-col gap-1 text-xs"><span>登录 {formatDateTime(tenant.lastLoginAt)}</span><span className="text-muted-foreground">到期 {tenant.expiresAt ? formatDateTime(tenant.expiresAt) : "长期"}</span><span className="text-muted-foreground">创建 {formatDateTime(tenant.createdAt)}</span></div>
                    </TableCell>
                    <TableCell>
                      <TooltipProvider><div className="flex min-w-32 flex-wrap justify-end gap-1">
                        <TenantAction label="管理子订阅"><Button type="button" variant="outline" size="icon" aria-label="管理子订阅" onClick={() => setSubscriptionTenant(tenant)}><PackagePlusIcon /></Button></TenantAction>
                        <TenantAction label="编辑租户"><Button type="button" variant="outline" size="icon" aria-label="编辑租户" onClick={() => setEditing(tenant)}><PencilIcon /></Button></TenantAction>
                        <TenantAction label="生成密码重置链接"><Button type="button" variant="outline" size="icon" aria-label="生成密码重置链接" disabled={!tenant.ownerEmail} onClick={() => resetPassword(tenant.id)}><KeyRoundIcon /></Button></TenantAction>
                        <TenantAction label="强制退出所有设备"><Button type="button" variant="outline" size="icon" aria-label="强制退出所有设备" disabled={!tenant.ownerEmail} onClick={() => revokeSessions(tenant.id)}><LogOutIcon /></Button></TenantAction>
                        <TenantAction label="生成邀请链接"><Button type="button" variant="outline" size="icon" aria-label="生成邀请链接" disabled={Boolean(tenant.ownerEmail || tenant.pendingInvite)} onClick={() => inviteTenant(tenant.id)}><LinkIcon /></Button></TenantAction>
                        <TenantAction label="删除租户"><Button type="button" variant="outline" size="icon" aria-label="删除租户" onClick={() => removeTenant(tenant.id)}><Trash2Icon /></Button></TenantAction>
                      </div></TooltipProvider>
                    </TableCell>
                  </TableRow>;
                })}
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
        publicBaseUrl={publicBaseUrl}
        onOpenChange={(open) => {
          if (!open) {
            setPendingInvite(null);
          }
        }}
      />
      <PasswordResetDialog value={passwordReset} onOpenChange={(open) => { if (!open) setPasswordReset(null); }} />
      <SubscriptionDialog tenant={subscriptionTenant} onSubscriptionsChanged={setSubscriptions} onOpenChange={(open) => { if (!open) setSubscriptionTenant(null); }} />
    </>
  );
}

function PasswordResetDialog({ value, onOpenChange }: { value: { url: string; expiresAt: string } | null; onOpenChange: (open: boolean) => void }) {
  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value.url);
    toast.success("重置链接已复制");
  }
  return <Dialog open={Boolean(value)} onOpenChange={onOpenChange}>
    <DialogContent><DialogHeader><DialogTitle>密码重置链接</DialogTitle><DialogDescription>链接一小时内单次有效；再次生成会使旧链接失效。</DialogDescription></DialogHeader>
      <div className="rounded-md border bg-muted/50 p-3 text-sm break-all">{value?.url}</div>
      <p className="text-sm text-muted-foreground">过期时间：{formatDateTime(value?.expiresAt || null)}</p>
      <DialogFooter><Button type="button" variant="outline" onClick={copy}><CopyIcon data-icon="inline-start" />复制链接</Button><Button type="button" onClick={() => onOpenChange(false)}>完成</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
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
                <FieldLabel>模型白名单</FieldLabel>
                <ModelSelector selectedModels={parseList(form.modelAllowlist)} onSelectedModelsChange={(models) => setForm((current) => ({ ...current, modelAllowlist: models.join("\n") }))} />
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
  publicBaseUrl,
}: {
  invite: CreatedTenantInvite | null;
  onOpenChange: (open: boolean) => void;
  publicBaseUrl: string;
}) {
  const origin = publicBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const inviteUrl = invite ? `${origin.replace(/\/$/, "")}/tenant/activate?token=${encodeURIComponent(invite.token)}` : "";
  async function copyInvite() {
    if (!invite) {
      return;
    }
    await navigator.clipboard.writeText(inviteUrl);
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
          {inviteUrl}
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
    modelAllowlist: [...new Set(parseList(form.modelAllowlist).map(stripThinkingLevel).filter(Boolean))],
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

function TenantAction({ children, label }: { children: React.ReactElement; label: string }) {
  return <Tooltip><TooltipTrigger render={children} /><TooltipContent>{label}</TooltipContent></Tooltip>;
}

function SubscriptionDialog({ tenant, onOpenChange, onSubscriptionsChanged }: { tenant: PublicTenant | null; onOpenChange: (open: boolean) => void; onSubscriptionsChanged: (items: TenantSubscriptionRecord[]) => void }) {
  const [items, setItems] = React.useState<TenantSubscriptionRecord[]>([]);
  const [allItems, setAllItems] = React.useState<TenantSubscriptionRecord[]>([]);
  const [credentials, setCredentials] = React.useState<SubscriptionCapacityPool[]>([]);
  const [credentialId, setCredentialId] = React.useState("");
  const [name, setName] = React.useState("");
  const [units, setUnits] = React.useState("1");
  const [denominator, setDenominator] = React.useState("20");
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    if (!tenant) return;
    void Promise.all([listTenantSubscriptions(tenant.id), listTenantSubscriptions(), getSubscriptionAllocationOverview()])
      .then(([tenantItems, subscriptions, overview]) => { setItems(tenantItems); setAllItems(subscriptions); onSubscriptionsChanged(subscriptions); setCredentials(overview.pools); })
      .catch((error) => toast.error(adminErrorMessage(error)));
  }, [tenant, onSubscriptionsChanged]);
  const selectedCredential = credentials.find((credential) => credential.id === credentialId);
  const allocated = credentialId ? allocatedRatio(allItems, credentialId) : 0;
  function selectCredential(id: string | null) {
    const credential = credentials.find((item) => item.id === id);
    const suggestedDenominator = credential?.capacityUnits || 1;
    setCredentialId(id || "");
    setDenominator(String(suggestedDenominator));
    setName(credential ? `${planLabel(credential)} 子订阅` : "");
  }
  async function create() { if (!tenant) return; setPending(true); try { const item = await createTenantSubscription({ tenantId: tenant.id, credentialId, name: name.trim(), units: positiveShare(units, "持有份数"), unitsPerCredential: positiveShare(denominator, "整份拆分数") }); setItems((current) => [item, ...current]); setAllItems((current) => { const next = [item, ...current]; onSubscriptionsChanged(next); return next; }); setCredentialId(""); setName(""); toast.success("子订阅已下发"); } catch (error) { toast.error(adminErrorMessage(error)); } finally { setPending(false); } }
  async function remove(id: string) { if (!window.confirm("确认收回这个子订阅？")) return; try { await deleteTenantSubscription(id); setItems((current) => current.filter((item) => item.id !== id)); setAllItems((current) => { const next = current.filter((item) => item.id !== id); onSubscriptionsChanged(next); return next; }); toast.success("子订阅已收回"); } catch (error) { toast.error(adminErrorMessage(error)); } }
  return <Dialog open={Boolean(tenant)} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>管理子订阅</DialogTitle><DialogDescription>为 {tenant?.ownerEmail || tenant?.name || "租户用户"} 从具体上游凭据下发份额。只有该用户可以使用父订阅凭据所在的通道。</DialogDescription></DialogHeader><FieldGroup><div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel>上游凭据</FieldLabel><Select value={credentialId || null} onValueChange={selectCredential}><SelectTrigger className="w-full"><SelectValue placeholder="选择上游凭据" /></SelectTrigger><SelectContent><SelectGroup>{credentials.map((credential) => { const used = allocatedRatio(allItems, credential.id); return <SelectItem key={credential.id} value={credential.id} disabled={!credential.enabled}><span className="flex min-w-0 flex-1 items-center justify-between gap-3"><span className="truncate">{credential.email || credential.accountId || credential.id} · {planLabel(credential)}</span><span className="text-xs text-muted-foreground">已分配 {formatPercent(used)}{used > 1 ? " · 超卖" : ""}</span></span></SelectItem>; })}</SelectGroup></SelectContent></Select><FieldDescription>{selectedCredential ? allocated > 1 ? `已分配 ${formatPercent(allocated)}，当前超卖 ${formatPercent(allocated - 1)}` : `已分配 ${formatPercent(allocated)}，物理余量 ${formatPercent(1 - allocated)}；仍可继续超卖` : "可选择任意已接入厂商的凭据，系统会建议该容量池的默认拆分数。"}</FieldDescription></Field><Field><FieldLabel htmlFor="subscription-name">展示名称</FieldLabel><Input id="subscription-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="厂商套餐子订阅" /></Field><Field><FieldLabel htmlFor="subscription-units">持有份数</FieldLabel><Input id="subscription-units" inputMode="decimal" value={units} onChange={(event) => setUnits(event.target.value)} /></Field><Field><FieldLabel htmlFor="subscription-denominator">整份拆分数</FieldLabel><Input id="subscription-denominator" inputMode="decimal" value={denominator} onChange={(event) => setDenominator(event.target.value)} /><FieldDescription>例如 1/5 表示父订阅的 20%；Codex、Grok 与以后新增的厂商使用同一规则。</FieldDescription></Field></div><Button type="button" disabled={pending || !credentialId} onClick={create}>{pending && <Spinner data-icon="inline-start" />}下发子订阅</Button></FieldGroup><Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead>用户</TableHead><TableHead>份额</TableHead><TableHead>凭据</TableHead><TableHead>状态</TableHead><TableHead /></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell>{item.name}</TableCell><TableCell>{item.user?.email || tenant?.ownerEmail || "未绑定"}</TableCell><TableCell>{item.units}/{item.unitsPerCredential}</TableCell><TableCell>{credentialName(credentials, item.credentialId)}</TableCell><TableCell>{item.enabled ? "启用" : "停用"}</TableCell><TableCell className="text-right"><Button type="button" variant="outline" size="icon" aria-label="收回子订阅" onClick={() => remove(item.id)}><Trash2Icon /></Button></TableCell></TableRow>)}</TableBody></Table><DialogFooter><Button type="button" onClick={() => onOpenChange(false)}>完成</Button></DialogFooter></DialogContent></Dialog>;
}

function allocatedRatio(items: TenantSubscriptionRecord[], credentialId: string) { return items.filter((item) => item.enabled && item.credentialId === credentialId).reduce((sum, item) => sum + item.units / item.unitsPerCredential, 0); }
function formatPercent(value: number) { return `${Math.round(value * 1000) / 10}%`; }
function planLabel(credential: Pick<SubscriptionCapacityPool, "provider" | "planType">) { return providerPlanLabel(credential.provider, credential.planType); }
function credentialName(credentials: SubscriptionCapacityPool[], id: string) { const credential = credentials.find((item) => item.id === id); return credential ? `${credential.email || credential.accountId || id} · ${planLabel(credential)}` : id; }
function positiveShare(value: string, label: string) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label}必须是大于 0 的数字`); return parsed; }



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
