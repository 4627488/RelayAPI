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
  adminErrorMessage,
  createTenant,
  createTenantInvite,
  createTenantPasswordReset,
  createTenantSubscription,
  deleteTenantSubscription,
  listTenantSubscriptions,
  listCredentials,
  deleteTenant,
  revokeTenantSessions,
  updateTenant,
  type TenantPayload,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import type { CodexCredentialRecord, CreatedTenantInvite, PublicTenant } from "@/src/shared/types/entities";

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
                        <div><div>{tenant.ownerEmail}</div><div className="text-xs text-muted-foreground">最后登录 {formatDateTime(tenant.lastLoginAt)}</div></div>
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
                          type="button" variant="outline" size="icon" aria-label="管理子订阅"
                          onClick={() => setSubscriptionTenant(tenant)}
                        ><PackagePlusIcon /></Button>
                        <Button
                          type="button" variant="outline" size="icon" aria-label="生成密码重置链接"
                          disabled={!tenant.ownerEmail} onClick={() => resetPassword(tenant.id)}
                        ><KeyRoundIcon /></Button>
                        <Button
                          type="button" variant="outline" size="icon" aria-label="强制退出所有设备"
                          disabled={!tenant.ownerEmail} onClick={() => revokeSessions(tenant.id)}
                        ><LogOutIcon /></Button>
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
        publicBaseUrl={publicBaseUrl}
        onOpenChange={(open) => {
          if (!open) {
            setPendingInvite(null);
          }
        }}
      />
      <PasswordResetDialog value={passwordReset} onOpenChange={(open) => { if (!open) setPasswordReset(null); }} />
      <SubscriptionDialog tenant={subscriptionTenant} onOpenChange={(open) => { if (!open) setSubscriptionTenant(null); }} />
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

function SubscriptionDialog({ tenant, onOpenChange }: { tenant: PublicTenant | null; onOpenChange: (open: boolean) => void }) {
  const [items, setItems] = React.useState<TenantSubscriptionRecord[]>([]);
  const [allItems, setAllItems] = React.useState<TenantSubscriptionRecord[]>([]);
  const [credentials, setCredentials] = React.useState<CodexCredentialRecord[]>([]);
  const [credentialId, setCredentialId] = React.useState("");
  const [name, setName] = React.useState("");
  const [units, setUnits] = React.useState("1");
  const [denominator, setDenominator] = React.useState("20");
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    if (!tenant) return;
    void Promise.all([listTenantSubscriptions(tenant.id), listTenantSubscriptions(), listCredentials()])
      .then(([tenantItems, subscriptions, credentialItems]) => { setItems(tenantItems); setAllItems(subscriptions); setCredentials(credentialItems); })
      .catch((error) => toast.error(adminErrorMessage(error)));
  }, [tenant]);
  const selectedCredential = credentials.find((credential) => credential.id === credentialId);
  const allocated = credentialId ? allocatedRatio(allItems, credentialId) : 0;
  function selectCredential(id: string | null) {
    const credential = credentials.find((item) => item.id === id);
    const suggestedDenominator = credential?.planType.toLowerCase().includes("pro") ? 20 : 1;
    setCredentialId(id || "");
    setDenominator(String(suggestedDenominator));
    setName(credential ? `${planLabel(credential.planType)} 子订阅` : "");
  }
  async function create() { if (!tenant) return; setPending(true); try { const item = await createTenantSubscription({ tenantId: tenant.id, credentialId, name: name.trim(), units: Math.max(1, Number(units) || 1), unitsPerCredential: Math.max(1, Number(denominator) || 20) }); setItems((current) => [item, ...current]); setAllItems((current) => [item, ...current]); setCredentialId(""); setName(""); toast.success("子订阅已下发"); } catch (error) { toast.error(adminErrorMessage(error)); } finally { setPending(false); } }
  async function remove(id: string) { if (!window.confirm("确认收回这个子订阅？")) return; try { await deleteTenantSubscription(id); setItems((current) => current.filter((item) => item.id !== id)); setAllItems((current) => current.filter((item) => item.id !== id)); toast.success("子订阅已收回"); } catch (error) { toast.error(adminErrorMessage(error)); } }
  return <Dialog open={Boolean(tenant)} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>管理子订阅</DialogTitle><DialogDescription>为 {tenant?.name || "租户"} 从具体上游凭据下发份额。总分配比例不能超过该凭据的 100%。</DialogDescription></DialogHeader><FieldGroup><div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel>上游凭据</FieldLabel><Select value={credentialId || null} onValueChange={selectCredential}><SelectTrigger className="w-full"><SelectValue placeholder="选择上游凭据" /></SelectTrigger><SelectContent><SelectGroup>{credentials.map((credential) => { const used = allocatedRatio(allItems, credential.id); return <SelectItem key={credential.id} value={credential.id} disabled={!credential.enabled || used >= 1}><span className="flex min-w-0 flex-1 items-center justify-between gap-3"><span className="truncate">{credential.email || credential.accountId || credential.id} · {planLabel(credential.planType)}</span><span className="text-xs text-muted-foreground">已分配 {formatPercent(used)}</span></span></SelectItem>; })}</SelectGroup></SelectContent></Select><FieldDescription>{selectedCredential ? `已分配 ${formatPercent(allocated)}，剩余 ${formatPercent(Math.max(0, 1 - allocated))}` : "选择后会自动建议 Pro 或 Plus 的拆分数。"}</FieldDescription></Field><Field><FieldLabel htmlFor="subscription-name">展示名称</FieldLabel><Input id="subscription-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Pro20x 子订阅" /></Field><Field><FieldLabel htmlFor="subscription-units">持有份数</FieldLabel><Input id="subscription-units" inputMode="numeric" value={units} onChange={(event) => setUnits(event.target.value)} /></Field><Field><FieldLabel htmlFor="subscription-denominator">整份拆分数</FieldLabel><Input id="subscription-denominator" inputMode="numeric" value={denominator} onChange={(event) => setDenominator(event.target.value)} /><FieldDescription>Pro20x 默认 20；独享 Plus 默认 1。</FieldDescription></Field></div><Button type="button" disabled={pending || !credentialId} onClick={create}>{pending && <Spinner data-icon="inline-start" />}下发子订阅</Button></FieldGroup><Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead>份额</TableHead><TableHead>凭据</TableHead><TableHead>状态</TableHead><TableHead /></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell>{item.name}</TableCell><TableCell>{item.units}/{item.unitsPerCredential}</TableCell><TableCell>{credentialName(credentials, item.credentialId)}</TableCell><TableCell>{item.enabled ? "启用" : "停用"}</TableCell><TableCell className="text-right"><Button type="button" variant="outline" size="icon" aria-label="收回子订阅" onClick={() => remove(item.id)}><Trash2Icon /></Button></TableCell></TableRow>)}</TableBody></Table><DialogFooter><Button type="button" onClick={() => onOpenChange(false)}>完成</Button></DialogFooter></DialogContent></Dialog>;
}

function allocatedRatio(items: TenantSubscriptionRecord[], credentialId: string) { return items.filter((item) => item.enabled && item.credentialId === credentialId).reduce((sum, item) => sum + item.units / item.unitsPerCredential, 0); }
function formatPercent(value: number) { return `${Math.round(value * 1000) / 10}%`; }
function planLabel(planType: string) { const plan = planType.trim().toLowerCase(); return plan.includes("pro") ? "Pro20x" : plan.includes("plus") ? "Plus" : planType || "Codex"; }
function credentialName(credentials: CodexCredentialRecord[], id: string) { const credential = credentials.find((item) => item.id === id); return credential ? `${credential.email || credential.accountId || id} · ${planLabel(credential.planType)}` : id; }



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
