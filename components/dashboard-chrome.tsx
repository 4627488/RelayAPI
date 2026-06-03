"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type DashboardNavItem<TId extends string> = {
  id: TId;
  label: string;
  description: string;
  icon: LucideIcon;
  count?: number;
};

type DashboardChromeProps<TId extends string> = {
  activeId: TId;
  children: React.ReactNode;
  eyebrow: string;
  navItems: DashboardNavItem<TId>[];
  onNavChange: (id: TId) => void;
  status?: React.ReactNode;
  summary?: React.ReactNode;
  title: React.ReactNode;
  description: React.ReactNode;
  actions: React.ReactNode;
  snapshot: React.ReactNode;
  width?: "admin" | "tenant";
};

export function DashboardChrome<TId extends string>({
  activeId,
  actions,
  children,
  description,
  eyebrow,
  navItems,
  onNavChange,
  snapshot,
  status,
  summary,
  title,
  width = "tenant",
}: DashboardChromeProps<TId>) {
  const activeItem = navItems.find((item) => item.id === activeId);

  return (
    <main className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-48 bg-[linear-gradient(180deg,color-mix(in_oklch,var(--primary)_18%,transparent),transparent)]" />
      <div
        className={cn(
          "relative mx-auto flex w-full flex-col gap-4 px-3 py-3 sm:px-5 lg:py-5 2xl:px-8",
          width === "admin" ? "max-w-450" : "max-w-420",
        )}
      >
        <header className="overflow-hidden rounded-xl border bg-card/95 text-card-foreground shadow-sm">
          <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{eyebrow}</Badge>
                {status}
              </div>
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl leading-tight font-semibold sm:text-3xl">
                  {title}
                </h1>
                <p className="max-w-5xl text-sm leading-6 text-muted-foreground">
                  {description}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 lg:items-end">
              <div className="flex flex-wrap gap-2 lg:justify-end">
                {actions}
              </div>
              <p className="text-xs text-muted-foreground">{snapshot}</p>
            </div>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
          <aside className="h-fit rounded-xl border bg-card/95 p-2 shadow-sm lg:sticky lg:top-5">
            {activeItem && <DashboardActiveItem item={activeItem} />}
            <Separator className="my-1" />
            <nav className="grid gap-1 py-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onNavChange(item.id)}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-none">
                        {item.label}
                      </span>
                      <span
                        className={cn(
                          "mt-1 block truncate text-xs leading-none",
                          active
                            ? "text-primary-foreground/75"
                            : "text-muted-foreground",
                        )}
                      >
                        {item.description}
                      </span>
                    </span>
                    {typeof item.count === "number" && (
                      <span
                        className={cn(
                          "rounded-md px-2 py-0.5 text-xs tabular-nums",
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
              })}
            </nav>
            {summary && (
              <>
                <Separator className="my-1" />
                <div className="grid gap-2 px-3 py-3 text-xs text-muted-foreground">
                  {summary}
                </div>
              </>
            )}
          </aside>

          <section className="min-w-0">{children}</section>
        </div>
      </div>
    </main>
  );
}

function formatNavCount(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function DashboardActiveItem<TId extends string>({
  item,
}: {
  item: DashboardNavItem<TId>;
}) {
  const Icon = item.icon;

  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{item.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {item.description}
        </div>
      </div>
    </div>
  );
}

export function DashboardSummaryLine({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
