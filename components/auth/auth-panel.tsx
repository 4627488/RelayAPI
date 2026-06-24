import * as React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";

export function AuthPanel({
  children,
  eyebrow,
  meta,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  meta?: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/25 px-3 py-6">
      <div className="grid w-full max-w-sm gap-2">
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="font-mono text-xs text-muted-foreground">RelayAPI</div>
          <WorkspaceStatusBadge tone="muted">{eyebrow}</WorkspaceStatusBadge>
        </div>
        <Card className="rounded-lg py-0 shadow-sm">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-base">{title}</CardTitle>
            {meta && (
              <div className="font-mono text-xs text-muted-foreground">
                {meta}
              </div>
            )}
          </CardHeader>
          <CardContent className="px-4 py-4">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
