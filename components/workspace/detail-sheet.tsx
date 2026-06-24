"use client";

import * as React from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function WorkbenchDetailSheet({
  children,
  className,
  description,
  onOpenChange,
  open,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={cn("w-full gap-0 sm:max-w-2xl", className)}>
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
