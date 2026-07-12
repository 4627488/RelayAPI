"use client";

import * as React from "react";
import { MenuIcon, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type WorkspaceNavItem<TId extends string> = {
  id: TId;
  label: string;
  icon: LucideIcon;
  count?: number;
  group?: string;
};

export function WorkspaceShell<TId extends string>({
  activeId,
  actions,
  children,
  className,
  navItems,
  onNavChange,
  status,
  title,
  width = "tenant",
}: {
  activeId: TId;
  actions: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  navItems: WorkspaceNavItem<TId>[];
  onNavChange: (id: TId) => void;
  status?: React.ReactNode;
  title: React.ReactNode;
  width?: "admin" | "tenant";
}) {
  const activeItem = navItems.find((item) => item.id === activeId);
  const groups = groupItems(navItems);

  return (
    <main className="min-h-screen bg-muted/30 text-sm">
      <div
        className={cn(
          "mx-auto grid min-h-screen w-full lg:grid-cols-[13.5rem_minmax(0,1fr)]",
          width === "admin" ? "max-w-[1920px]" : "max-w-[1680px]",
          className,
        )}
      >
        <aside className="hidden border-r bg-card lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
          <Brand status={status} />
          <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-4">
            <NavigationGroups
              activeId={activeId}
              groups={groups}
              onNavChange={onNavChange}
            />
          </nav>
          <div className="border-t p-2">{actions}</div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur sm:px-5">
            <MobileNavigation
              activeId={activeId}
              groups={groups}
              onNavChange={onNavChange}
              status={status}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.68rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                {activeItem?.group ?? "控制台"}
              </div>
              <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
            </div>
            <ThemeToggle />
            <div className="hidden items-center gap-1.5 lg:flex">{actions}</div>
          </header>
          <section className="min-w-0 p-2.5 sm:p-4 xl:p-5">{children}</section>
        </div>
      </div>
    </main>
  );
}

function Brand({ status }: { status?: React.ReactNode }) {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b px-3">
      <div className="grid size-7 place-items-center rounded-md bg-primary font-mono text-xs font-bold text-primary-foreground">
        R
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold tracking-tight">RelayAPI</div>
        <div className="text-[0.68rem] text-muted-foreground">Operations</div>
      </div>
      {status}
    </div>
  );
}

function MobileNavigation<TId extends string>({
  activeId,
  groups,
  onNavChange,
  status,
}: {
  activeId: TId;
  groups: Array<[string, WorkspaceNavItem<TId>[]]>;
  onNavChange: (id: TId) => void;
  status?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="lg:hidden" />}
      >
        <MenuIcon />
        <span className="sr-only">打开导航</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center justify-between gap-3">
            RelayAPI
            {status}
          </SheetTitle>
        </SheetHeader>
        <nav aria-label="主导航" className="flex flex-col gap-5 overflow-y-auto p-3">
          <NavigationGroups
            activeId={activeId}
            groups={groups}
            onNavChange={(id) => {
              onNavChange(id);
              setOpen(false);
            }}
          />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function NavigationGroups<TId extends string>({ activeId, groups, onNavChange }: {
  activeId: TId;
  groups: Array<[string, WorkspaceNavItem<TId>[]]>;
  onNavChange: (id: TId) => void;
}) {
  return groups.map(([group, items]) => (
    <div className="flex flex-col gap-1" key={group}>
      <div className="px-2 text-[0.65rem] font-semibold tracking-[0.14em] text-muted-foreground/75 uppercase">
        {group}
      </div>
      {items.map((item) => (
        <WorkspaceNavButton
          active={item.id === activeId}
          item={item}
          key={item.id}
          onClick={() => onNavChange(item.id)}
        />
      ))}
    </div>
  ));
}

function WorkspaceNavButton<TId extends string>({ active, item, onClick }: {
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
        "group relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {typeof item.count === "number" && (
        <span className="font-mono text-[0.68rem] tabular-nums text-muted-foreground">
          {formatNavCount(item.count)}
        </span>
      )}
    </button>
  );
}

function groupItems<TId extends string>(items: WorkspaceNavItem<TId>[]) {
  const groups = new Map<string, WorkspaceNavItem<TId>[]>();
  for (const item of items) {
    const group = item.group ?? "工作区";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return [...groups.entries()];
}

function formatNavCount(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
    notation: value >= 10000 ? "compact" : "standard",
  }).format(value);
}
