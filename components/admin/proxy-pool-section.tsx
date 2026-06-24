"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  DatabaseIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

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
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
  createProxyPoolItem,
  deleteProxyPoolItem,
  listProxyPoolItems,
  updateProxyPoolItem,
  type ProxyPoolPayload,
} from "@/lib/admin-api";
import type {
  CredentialProxyType,
  ProxyPoolRecord,
} from "@/src/shared/types/entities";

type ProxyPoolFormState = {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
  name: string;
  notes: string;
};

export function ProxyPoolSection({
  proxyPool,
  onChanged,
}: {
  proxyPool: ProxyPoolRecord[];
  onChanged: (proxyPool: ProxyPoolRecord[]) => void;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProxyPoolRecord | null>(null);
  const [form, setForm] = React.useState<ProxyPoolFormState>(() =>
    emptyProxyPoolForm(),
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  function patchForm(patch: Partial<ProxyPoolFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyProxyPoolForm());
    setDialogOpen(true);
  }

  function openEdit(proxy: ProxyPoolRecord) {
    setEditing(proxy);
    setForm(proxyPoolForm(proxy));
    setDialogOpen(true);
  }

  async function refreshProxyPool() {
    onChanged(await listProxyPoolItems());
  }

  async function saveProxy() {
    const payload = proxyPoolPayload(form, editing);
    if (!payload) {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateProxyPoolItem(editing.id, payload);
        onChanged([
          updated,
          ...proxyPool.filter((proxy) => proxy.id !== updated.id),
        ]);
        toast.success("代理已更新");
      } else {
        const created = await createProxyPoolItem(payload);
        onChanged([created, ...proxyPool]);
        toast.success("代理已添加");
      }
      setDialogOpen(false);
      setEditing(null);
      setForm(emptyProxyPoolForm());
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeProxy(proxy: ProxyPoolRecord) {
    setPendingId(proxy.id);
    try {
      await deleteProxyPoolItem(proxy.id);
      onChanged(proxyPool.filter((item) => item.id !== proxy.id));
      toast.success("代理已删除");
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
          <CardTitle>代理池</CardTitle>
          <CardAction>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={refreshProxyPool}
              >
                <RefreshCwIcon data-icon="inline-start" />
                刷新
              </Button>
              <Button type="button" onClick={openCreate}>
                <PlusIcon data-icon="inline-start" />
                添加
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {proxyPool.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DatabaseIcon />
                </EmptyMedia>
                <EmptyTitle>还没有代理</EmptyTitle>
                <EmptyDescription>添加后可绑定到凭据。</EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={openCreate}>
                <PlusIcon data-icon="inline-start" />
                添加
              </Button>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>地址</TableHead>
                    <TableHead>认证</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最近使用</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proxyPool.map((proxy) => (
                    <TableRow key={proxy.id}>
                      <TableCell>
                        <div className="grid gap-1">
                          <span className="font-medium">{proxy.name}</span>
                          {proxy.notes && (
                            <span className="text-xs text-muted-foreground">
                              {proxy.notes}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {proxy.type}://{proxy.host}:{proxy.port}
                      </TableCell>
                      <TableCell>
                        {proxy.username ? (
                          <Badge variant="outline">
                            {proxy.username}
                            {proxy.passwordSet ? ":******" : ""}
                          </Badge>
                        ) : (
                          <Badge variant="outline">无用户名</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <WorkspaceStatusBadge
                          tone={proxy.enabled ? "success" : "muted"}
                        >
                          {proxy.enabled ? "on" : "off"}
                        </WorkspaceStatusBadge>
                      </TableCell>
                      <TableCell>
                        {formatNullableDate(proxy.lastUsedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pendingId === proxy.id}
                            onClick={() => openEdit(proxy)}
                          >
                            <PencilIcon data-icon="inline-start" />
                            编辑
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pendingId === proxy.id}
                            onClick={() => removeProxy(proxy)}
                          >
                            {pendingId === proxy.id ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Trash2Icon data-icon="inline-start" />
                            )}
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑代理" : "添加代理"}</DialogTitle>
            <DialogDescription>
              密码会在服务端加密保存，前端列表不会返回明文。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input
                disabled={saving}
                value={form.name}
                placeholder="香港 GOST 01"
                onChange={(event) => patchForm({ name: event.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-[0.8fr_1fr_0.7fr]">
              <Field>
                <FieldLabel>协议</FieldLabel>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving}
                  value={form.type}
                  onChange={(event) =>
                    patchForm({
                      type: event.target.value as CredentialProxyType,
                    })
                  }
                >
                  <option value="socks5h">socks5h</option>
                  <option value="socks5">socks5</option>
                </select>
              </Field>
              <Field>
                <FieldLabel>主机</FieldLabel>
                <Input
                  disabled={saving}
                  value={form.host}
                  placeholder="127.0.0.1"
                  onChange={(event) => patchForm({ host: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>端口</FieldLabel>
                <Input
                  disabled={saving}
                  inputMode="numeric"
                  value={form.port}
                  placeholder="1080"
                  onChange={(event) => patchForm({ port: event.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>用户名（可选）</FieldLabel>
                <Input
                  disabled={saving}
                  value={form.username}
                  placeholder="username"
                  onChange={(event) =>
                    patchForm({ username: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel>密码（留空保持原密码）</FieldLabel>
                <Input
                  disabled={saving}
                  type="password"
                  value={form.password}
                  placeholder={
                    editing?.passwordSet ? "已设置，留空保持不变" : "password"
                  }
                  onChange={(event) =>
                    patchForm({ password: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>备注</FieldLabel>
              <Textarea
                disabled={saving}
                value={form.notes}
                placeholder="可选备注"
                onChange={(event) => patchForm({ notes: event.target.value })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>启用代理</FieldLabel>
                <FieldDescription>
                  停用后引用它的凭据会继续回退到全局代理或直连。
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={form.enabled}
                disabled={saving}
                onCheckedChange={(checked) =>
                  patchForm({ enabled: Boolean(checked) })
                }
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={saveProxy}>
              {saving && <Spinner data-icon="inline-start" />}
              保存代理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function emptyProxyPoolForm(): ProxyPoolFormState {
  return {
    name: "",
    enabled: true,
    type: "socks5h",
    host: "",
    port: "1080",
    username: "",
    password: "",
    notes: "",
  };
}

function proxyPoolForm(proxy: ProxyPoolRecord): ProxyPoolFormState {
  return {
    name: proxy.name,
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: String(proxy.port),
    username: proxy.username,
    password: "",
    notes: proxy.notes,
  };
}

function proxyPoolPayload(
  form: ProxyPoolFormState,
  existing: ProxyPoolRecord | null,
): ProxyPoolPayload | null {
  const name = form.name.trim();
  const host = form.host.trim();
  const port = integerValue(form.port, 0);
  if (!name) {
    toast.error("请输入代理名称");
    return null;
  }
  if (!host) {
    toast.error("请输入 SOCKS5 代理主机");
    return null;
  }
  if (port < 1 || port > 65535) {
    toast.error("代理端口必须在 1 到 65535 之间");
    return null;
  }
  return {
    name,
    enabled: form.enabled,
    type: form.type,
    host,
    port,
    username: form.username.trim(),
    ...(form.password.trim() || !existing ? { password: form.password } : {}),
    notes: form.notes.trim(),
  };
}

function integerValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
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
