"use client";

import * as React from "react";
import { ShieldAlertIcon } from "lucide-react";

import { AuthPanel } from "@/components/auth/auth-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { activateTenant } from "@/lib/tenant-api";

export function TenantActivate({ token }: { token: string }) {
  const [displayName, setDisplayName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setError("邀请链接缺少 token");
      return;
    }
    if (!displayName.trim()) {
      setError("请输入姓名");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请输入有效邮箱");
      return;
    }
    if (password.length < 10) {
      setError("密码至少需要 10 位");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setPending(true);
    setError("");
    try {
      await activateTenant({
        token,
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      });
      window.location.assign("/tenant");
    } catch (activateError) {
      setError(
        activateError instanceof Error
          ? activateError.message
          : String(activateError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
      <AuthPanel meta="租户邀请" title="激活账号">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {error && (
          <Alert variant="destructive">
            <ShieldAlertIcon />
            <AlertTitle>激活失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="tenant-display-name">姓名</FieldLabel>
            <Input
              id="tenant-display-name"
              autoFocus
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-email">邮箱</FieldLabel>
            <Input
              id="tenant-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-new-password">密码</FieldLabel>
            <Input
              id="tenant-new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tenant-confirm-password">确认密码</FieldLabel>
            <Input
              id="tenant-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={pending || !token}>
          {pending && <Spinner data-icon="inline-start" />}
          激活
        </Button>
      </form>
    </AuthPanel>
  );
}
