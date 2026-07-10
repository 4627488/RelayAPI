import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type WorkspaceStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const toneClasses: Record<WorkspaceStatusTone, string> = {
  neutral: "",
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "",
  muted: "text-muted-foreground",
};

export function WorkspaceStatusBadge({
  children,
  className,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: WorkspaceStatusTone;
}) {
  return (
    <Badge
      variant={tone === "danger" ? "destructive" : "outline"}
      className={cn("font-mono uppercase tracking-normal", toneClasses[tone], className)}
    >
      {children}
    </Badge>
  );
}
