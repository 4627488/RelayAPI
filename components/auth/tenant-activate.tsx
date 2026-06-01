"use client";

import * as React from "react";
import { ShieldAlertIcon, UserRoundIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { activateTenant } from "@/lib/tenant-api";

export function TenantActivate({ token }: { token: string }) {
  const [displayName, setDisplayName] = React.useState("");
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
    if (password.length < 8) {
      setError("密码至少需要 8 位");
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
        password,
        displayName: displayName.trim() || undefined,
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
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon />
          </div>
          <CardTitle className="text-xl">激活租户账号</CardTitle>
          <CardDescription>设置密码后即可进入自己的 RelayAPI 面板。</CardDescription>
        </CardHeader>
        <CardContent>
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
                <FieldLabel htmlFor="tenant-display-name">显示名</FieldLabel>
                <Input
                  id="tenant-display-name"
                  autoFocus
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <FieldDescription>可留空，之后将使用租户名称。</FieldDescription>
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
                <FieldLabel htmlFor="tenant-confirm-password">
                  确认密码
                </FieldLabel>
                <Input
                  id="tenant-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button type="submit" size="lg" disabled={pending || !token}>
              {pending && <Spinner data-icon="inline-start" />}
              激活并进入面板
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
