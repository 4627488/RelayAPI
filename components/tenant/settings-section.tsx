"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>租户设置</CardTitle>
        <CardDescription>这些设置只有在管理员允许后才可修改。</CardDescription>
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
            保存设置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
