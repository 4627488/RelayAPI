import type { ComponentType, ReactNode } from "react"
import {
  BarChart3Icon,
  ChevronsUpDownIcon,
  GaugeIcon,
  KeyRoundIcon,
  ListIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  SendIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { useTheme, type Theme } from "@/components/theme-provider"
import type { Session } from "@/lib/api"
import { initials } from "@/lib/format"

export type Page = "overview" | "usage" | "keys" | "logs" | "users" | "invitations" | "providers"

interface NavigationItem {
  id: Page
  label: string
  icon: ComponentType
}

const userItems: NavigationItem[] = [
  { id: "overview", label: "总览", icon: GaugeIcon },
  { id: "usage", label: "用量", icon: BarChart3Icon },
  { id: "keys", label: "API Keys", icon: KeyRoundIcon },
  { id: "logs", label: "请求日志", icon: ListIcon },
]

const adminItems: NavigationItem[] = [
  { id: "overview", label: "管理总览", icon: GaugeIcon },
  { id: "users", label: "用户", icon: UsersIcon },
  { id: "invitations", label: "邀请", icon: SendIcon },
  { id: "providers", label: "模型账户", icon: PlugIcon },
  { id: "usage", label: "全局用量", icon: BarChart3Icon },
  { id: "logs", label: "请求日志", icon: ListIcon },
]

const themes: Array<{ value: Theme; label: string; icon: ComponentType }> = [
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
  { value: "system", label: "跟随系统", icon: MonitorIcon },
]

function ThemeChoices({
  value,
  onValueChange,
}: {
  value: Theme
  onValueChange: (theme: Theme) => void
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Theme)}
    >
      {themes.map((item) => (
        <DropdownMenuRadioItem key={item.value} value={item.value}>
          <item.icon />
          {item.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

interface AppShellProps {
  session: Session
  page: Page
  onPageChange: (page: Page) => void
  onLogout: () => void
  children: ReactNode
}

export function AppShell({ session, page, onPageChange, onLogout, children }: AppShellProps) {
  const { theme, setTheme } = useTheme()
  const admin = session.role === "admin"
  const name = admin ? "管理员" : session.tenant?.name || "用户"
  const subtitle = admin ? "系统管理" : session.tenant?.owner_email || ""
  const items = admin ? adminItems : userItems

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" onClick={() => onPageChange("overview")}>
                <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <SendIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">RelayAPI</span>
                  <span className="truncate text-xs text-muted-foreground">Model Gateway</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{admin ? "管理" : "工作区"}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={page === item.id}
                      tooltip={item.label}
                      onClick={() => onPageChange(item.id)}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuButton size="lg" />}
                >
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
                  </div>
                  <ChevronsUpDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-56">
                  <DropdownMenuLabel>{name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>外观</DropdownMenuLabel>
                  <ThemeChoices value={theme} onValueChange={setTheme} />
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" onClick={onLogout}>
                      <LogOutIcon />
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <p className="text-sm font-medium">{items.find((item) => item.id === page)?.label}</p>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="选择主题" />
                }
              >
                {theme === "light" ? <SunIcon /> : theme === "dark" ? <MoonIcon /> : <MonitorIcon />}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>外观</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <ThemeChoices value={theme} onValueChange={setTheme} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex flex-1 flex-col p-4 pt-0 sm:p-6 sm:pt-0">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
