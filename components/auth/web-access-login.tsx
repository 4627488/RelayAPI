"use client";

import * as React from "react";
import { ShieldAlertIcon } from "lucide-react";

import { AuthPanel } from "@/components/auth/auth-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function WebAccessLogin() {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password.trim()) {
      setError("请输入账号和密码");
      return;
    }

    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmedUsername, password }),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(
          parsed?.error?.message || parsed?.message || "登录失败",
        );
      }
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      const safeReturnTo = returnTo?.startsWith("/api/oidc/authorize?") ? returnTo : null;
      window.location.assign(parsed?.role === "tenant" && safeReturnTo ? safeReturnTo : parsed?.role === "tenant" ? "/tenant" : "/");
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : String(loginError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPanel meta="管理员或租户" title="登录">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {error && (
          <Alert variant="destructive">
            <ShieldAlertIcon />
            <AlertTitle>验证失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="login-username">账号</FieldLabel>
            <Input
              id="login-username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin / email"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="login-password">密码</FieldLabel>
            <Input
              id="login-password"
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
