"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type WorkspaceNavItem<TId extends string> = {
  id: TId;
  label: string;
  icon: LucideIcon;
  count?: number;
};

export function WorkspaceShell<TId extends string>({
  activeId,
  actions,
  children,
  className,
  eyebrow,
  navItems,
  onNavChange,
  snapshot,
  status,
  summary,
  title,
  width = "tenant",
}: {
  activeId: TId;
  actions: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  eyebrow: string;
  navItems: WorkspaceNavItem<TId>[];
  onNavChange: (id: TId) => void;
  snapshot: React.ReactNode;
  status?: React.ReactNode;
  summary?: React.ReactNode;
  title: React.ReactNode;
  width?: "admin" | "tenant";
}) {
  const activeItem = navItems.find((item) => item.id === activeId);

  return (
    <main className="min-h-screen bg-muted/25 text-sm">
      <div
        className={cn(
          "mx-auto grid w-full gap-3 px-2 py-2 sm:px-3 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:py-3",
          width === "admin" ? "max-w-[1800px]" : "max-w-[1560px]",
          className,
        )}
      >
        <aside className="min-w-0 rounded-lg border bg-card lg:sticky lg:top-3 lg:h-[calc(100vh-1.5rem)]">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs text-muted-foreground">
                {eyebrow}
              </div>
              <div className="truncate text-sm font-medium">
                {activeItem?.label ?? "Workbench"}
              </div>
            </div>
            {status}
          </div>
          <nav className="flex gap-1 overflow-x-auto p-2 lg:grid lg:overflow-visible">
            {navItems.map((item) => (
              <WorkspaceNavButton
                active={item.id === activeId}
                item={item}
                key={item.id}
                onClick={() => onNavChange(item.id)}
              />
            ))}
          </nav>
          {summary && (
            <div className="hidden lg:block">
              <Separator />
              <div className="grid gap-2 p-3 text-xs text-muted-foreground">
                {summary}
              </div>
            </div>
          )}
        </aside>

        <div className="min-w-0">
          <header className="mb-3 rounded-lg border bg-card">
            <div className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold leading-7">
                  {title}
                </h1>
                {activeItem && (
                  <Badge variant="outline" className="font-mono">
                    {activeItem.label}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <div className="text-xs text-muted-foreground">{snapshot}</div>
                {actions}
              </div>
            </div>
            {summary && (
              <div className="border-t px-3 py-2 lg:hidden">
                <div className="grid gap-2 text-xs text-muted-foreground">
                  {summary}
                </div>
              </div>
            )}
          </header>
          <section className="min-w-0">{children}</section>
        </div>
      </div>
    </main>
  );
}

function WorkspaceNavButton<TId extends string>({
  active,
  item,
  onClick,
}: {
  active: boolean;
  item: WorkspaceNavItem<TId>;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 min-w-32 items-center gap-2 rounded-md px-2 text-left transition-colors lg:min-w-0",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {item.label}
        </span>
      </span>
      {typeof item.count === "number" && (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[0.68rem] tabular-nums",
            active
              ? "bg-primary-foreground/15 text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {formatNavCount(item.count)}
        </span>
      )}
    </button>
  );
}

function formatNavCount(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
    notation: value >= 10000 ? "compact" : "standard",
  }).format(value);
}

export function WorkspaceSummaryLine({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate">{label}</span>
      <span className="min-w-0 truncate text-right font-mono font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}
