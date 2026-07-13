import * as React from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function DataPanel({
  action,
  children,
  className,
  contentClassName,
  flush = false,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  flush?: boolean;
  title?: React.ReactNode;
}) {
  return (
    <Card className={cn("rounded-md py-0 shadow-none", className)}>
      {(title || action) && (
        <CardHeader className="min-h-10 border-b px-3 py-2">
          {title && <CardTitle>{title}</CardTitle>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={cn(flush ? "p-0" : "px-3 py-3", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}
