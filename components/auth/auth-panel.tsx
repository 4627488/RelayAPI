import * as React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AuthPanel({
  children,
  meta,
  title,
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/25 px-3 py-6">
      <div className="grid w-full max-w-sm gap-2">
        <div className="px-1 text-sm font-semibold tracking-tight">RelayAPI</div>
        <Card className="rounded-lg py-0 shadow-sm">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-base">{title}</CardTitle>
            {meta && (
              <div className="text-xs text-muted-foreground">
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
