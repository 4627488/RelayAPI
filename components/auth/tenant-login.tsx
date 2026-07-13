"use client";

import * as React from "react";
import { ShieldAlertIcon } from "lucide-react";

import { AuthPanel } from "@/components/auth/auth-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { loginTenant } from "@/lib/tenant-api";
import { WebAccessLogin } from "@/components/auth/web-access-login";

export function TenantLogin() {
  return <WebAccessLogin />;
}

export function LegacyTenantLogin() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("请输入租户邮箱和密码");
      return;
    }
    setPending(true);
    setError("");
    try {
      await loginTenant({ email: email.trim(), password });
      window.location.reload();
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : String(loginError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPanel meta="使用邮箱登录" title="租户登录">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {error && (
          <Alert variant="destructive">
            <ShieldAlertIcon />
            <AlertTitle>登录失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tenant-email">邮箱</FieldLabel>
            <Input
              id="tenant-email"
              type="email"
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-password">密码</FieldLabel>
            <Input
              id="tenant-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          进入
        </Button>
      </form>
    </AuthPanel>
  );
}
