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
  success: "text-foreground",
  warning: "text-foreground",
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
      className={cn("tabular-nums", toneClasses[tone], className)}
    >
      {children}
    </Badge>
  );
}
