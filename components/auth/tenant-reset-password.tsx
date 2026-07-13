"use client";

import * as React from "react";
import { ShieldAlertIcon } from "lucide-react";
import { AuthPanel } from "@/components/auth/auth-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { resetTenantPassword } from "@/lib/tenant-api";

export function TenantResetPassword({ token }: { token: string }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return setError("重置链接无效或已过期");
    if (password.length < 10) return setError("密码至少需要 10 位");
    if (password !== confirm) return setError("两次输入的密码不一致");
    setPending(true); setError("");
    try { await resetTenantPassword({ token, password }); window.location.assign("/tenant"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return (
    <AuthPanel meta="租户账号" title="重置密码">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {error && <Alert variant="destructive"><ShieldAlertIcon /><AlertTitle>无法重置密码</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <FieldGroup>
          <Field><FieldLabel htmlFor="reset-password">新密码</FieldLabel><Input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="reset-confirm">确认新密码</FieldLabel><Input id="reset-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Field>
        </FieldGroup>
        <Button type="submit" disabled={pending || !token}>{pending && <Spinner data-icon="inline-start" />}设置新密码</Button>
      </form>
    </AuthPanel>
  );
}
