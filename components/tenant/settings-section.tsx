"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import {
  changeTenantPassword,
  tenantErrorMessage,
  updateTenantSettings,
} from "@/lib/tenant-api";
import type { PublicTenant } from "@/src/shared/types/entities";

export function TenantSettingsSection({
  tenant,
  onSaved,
}: {
  tenant: PublicTenant;
  onSaved: (tenant: PublicTenant) => void;
}) {
  const [userAgent, setUserAgent] = React.useState(tenant.userAgent || "");
  const [proxyUrl, setProxyUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [passwords, setPasswords] = React.useState({ current: "", next: "", confirm: "" });
  const [passwordSaving, setPasswordSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload: { userAgent?: string | null; proxy?: string | null } = {};
      if (tenant.allowCustomUserAgent) {
        payload.userAgent = userAgent.trim() || null;
      }
      if (tenant.allowCustomProxy && proxyUrl.trim()) {
        payload.proxy = proxyUrl.trim();
      }
      const saved = await updateTenantSettings(payload);
      onSaved(saved);
      setProxyUrl("");
      toast.success("租户设置已保存");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwords.next.length < 10) return toast.error("新密码至少需要 10 位");
    if (passwords.next !== passwords.confirm) return toast.error("两次输入的新密码不一致");
    setPasswordSaving(true);
    try {
      await changeTenantPassword({ currentPassword: passwords.current, newPassword: passwords.next });
      setPasswords({ current: "", next: "", confirm: "" });
      toast.success("密码已修改，其他设备已退出登录");
    } catch (error) { toast.error(tenantErrorMessage(error)); }
    finally { setPasswordSaving(false); }
  }

  return (
    <div className="grid gap-3">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>租户设置</CardTitle>
          <div className="flex flex-wrap gap-1">
            <WorkspaceStatusBadge
              tone={tenant.allowCustomUserAgent ? "success" : "muted"}
            >
              ua {tenant.allowCustomUserAgent ? "on" : "locked"}
            </WorkspaceStatusBadge>
            <WorkspaceStatusBadge
              tone={tenant.allowCustomProxy ? "success" : "muted"}
            >
              proxy {tenant.allowCustomProxy ? "on" : "locked"}
            </WorkspaceStatusBadge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tenant-user-agent">User-Agent</FieldLabel>
            <Input
              id="tenant-user-agent"
              disabled={!tenant.allowCustomUserAgent}
              value={userAgent}
              placeholder={
                tenant.allowCustomUserAgent ? "留空使用全局设置" : "管理员未开放"
              }
              onChange={(event) => setUserAgent(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-proxy">SOCKS 代理 URL</FieldLabel>
            <Input
              id="tenant-proxy"
              disabled={!tenant.allowCustomProxy}
              value={proxyUrl}
              placeholder={
                tenant.allowCustomProxy
                  ? "socks5h://user:pass@127.0.0.1:1080"
                  : "管理员未开放"
              }
              onChange={(event) => setProxyUrl(event.target.value)}
            />
            <FieldDescription>
              当前代理：
              {tenant.proxy
                ? `${tenant.proxy.type}://${tenant.proxy.host}:${tenant.proxy.port}`
                : "未配置"}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div>
          <Button
            type="button"
            disabled={
              saving ||
              (!tenant.allowCustomProxy && !tenant.allowCustomUserAgent)
            }
            onClick={save}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>账户安全</CardTitle></CardHeader>
      <CardContent>
        <form className="grid max-w-xl gap-4" onSubmit={savePassword}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="tenant-current-password">当前密码</FieldLabel><Input id="tenant-current-password" type="password" autoComplete="current-password" value={passwords.current} onChange={(event) => setPasswords((value) => ({ ...value, current: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor="tenant-next-password">新密码</FieldLabel><Input id="tenant-next-password" type="password" autoComplete="new-password" value={passwords.next} onChange={(event) => setPasswords((value) => ({ ...value, next: event.target.value }))} /><FieldDescription>至少 10 位；修改后其他设备会退出登录。</FieldDescription></Field>
            <Field><FieldLabel htmlFor="tenant-confirm-password">确认新密码</FieldLabel><Input id="tenant-confirm-password" type="password" autoComplete="new-password" value={passwords.confirm} onChange={(event) => setPasswords((value) => ({ ...value, confirm: event.target.value }))} /></Field>
          </FieldGroup>
          <div><Button type="submit" disabled={passwordSaving}>{passwordSaving && <Spinner data-icon="inline-start" />}修改密码</Button></div>
        </form>
      </CardContent>
    </Card>
    </div>
  );
}
