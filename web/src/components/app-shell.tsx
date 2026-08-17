import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import {
  BarChart3Icon,
  BookOpenIcon,
  ChevronsUpDownIcon,
  GaugeIcon,
  KeyRoundIcon,
  ListIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  PackageOpenIcon,
  CircleDollarSignIcon,
  PlugIcon,
  SendIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { isTheme, useTheme, type Theme } from "@/components/theme-provider"
import type { Session } from "@/lib/api"
import { initials } from "@/lib/format"

export type Page =
  | "overview"
  | "usage"
  | "keys"
  | "logs"
  | "guide"
  | "users"
  | "invitations"
  | "providers"
  | "proxies"
  | "settings"
  | "subscriptions"
  | "pricing"
export type Workspace = "user" | "admin"

interface NavigationItem {
  id: Page
  label: string
  icon: ComponentType
}

const userItems: NavigationItem[] = [
  { id: "overview", label: "总览", icon: GaugeIcon },
  { id: "usage", label: "用量", icon: BarChart3Icon },
  { id: "keys", label: "API Keys", icon: KeyRoundIcon },
  { id: "guide", label: "接入指南", icon: BookOpenIcon },
  { id: "subscriptions", label: "我的订阅", icon: PackageOpenIcon },
  { id: "logs", label: "请求日志", icon: ListIcon },
]

function EmailAvatar({ email, name }: { email: string; name: string }) {
  const [source, setSource] = useState("")

  useEffect(() => {
    let active = true
    const normalized = email.trim().toLowerCase()
    setSource("")
    if (!normalized || !globalThis.crypto?.subtle) {
      setSource("")
      return () => {
        active = false
      }
    }
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(normalized))
      .then((buffer) => {
        if (!active) return
        const hash = Array.from(new Uint8Array(buffer), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
        setSource(`https://www.gravatar.com/avatar/${hash}?d=404&s=128`)
      })
      .catch(() => {
        if (active) setSource("")
      })
    return () => {
      active = false
    }
  }, [email])

  return (
    <Avatar className="size-8 rounded-lg">
      {source ? (
        <AvatarImage
          src={source}
          alt={`${name} 的头像`}
          className="rounded-lg"
        />
      ) : null}
      <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
    </Avatar>
  )
}

const adminItems: NavigationItem[] = [
  { id: "overview", label: "管理总览", icon: GaugeIcon },
  { id: "users", label: "用户", icon: UsersIcon },
  { id: "invitations", label: "邀请", icon: SendIcon },
  { id: "providers", label: "模型账户", icon: PlugIcon },
  { id: "proxies", label: "代理", icon: NetworkIcon },
  { id: "settings", label: "系统设置", icon: SlidersHorizontalIcon },
  { id: "subscriptions", label: "订阅分配", icon: PackageOpenIcon },
  { id: "usage", label: "全局用量", icon: BarChart3Icon },
  { id: "pricing", label: "模型定价", icon: CircleDollarSignIcon },
  { id: "logs", label: "请求日志", icon: ListIcon },
]

const themes: Array<{ value: Theme; label: string; icon: ComponentType }> = [
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
  { value: "system", label: "跟随系统", icon: MonitorIcon },
]

const buildCommit = (import.meta.env.VITE_GIT_COMMIT || "dev").trim()
const buildVersion =
  buildCommit === "dev" ? buildCommit : buildCommit.slice(0, 7)

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
      onValueChange={(nextValue) => {
        if (isTheme(nextValue)) {
          onValueChange(nextValue)
        }
      }}
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
  workspace: Workspace
  page: Page
  onPageChange: (page: Page) => void
  onWorkspaceChange: (workspace: Workspace) => void
  onLogout: () => void
  children: ReactNode
}

export function AppShell({
  session,
  workspace,
  page,
  onPageChange,
  onWorkspaceChange,
  onLogout,
  children,
}: AppShellProps) {
  const { theme, setTheme } = useTheme()
  const admin = workspace === "admin" && session.is_admin
  const name = session.tenant.name || "用户"
  const subtitle = session.tenant.owner_email || ""
  const items = admin ? adminItems : userItems

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                onClick={() => onPageChange("overview")}
              >
                <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <SendIcon />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">RelayAPI</span>
                  <span className="truncate text-xs text-muted-foreground">
                    模型网关
                  </span>
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
                <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                  <EmailAvatar email={subtitle} name={name} />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {subtitle}
                    </span>
                  </div>
                  <ChevronsUpDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-56">
                  <DropdownMenuLabel>{name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {session.is_admin ? (
                    <>
                      <DropdownMenuLabel>工作区</DropdownMenuLabel>
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onClick={() =>
                            onWorkspaceChange(admin ? "user" : "admin")
                          }
                        >
                          {admin ? <UserRoundIcon /> : <ShieldCheckIcon />}
                          {admin ? "返回个人面板" : "进入管理员面板"}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuLabel>外观</DropdownMenuLabel>
                  <ThemeChoices value={theme} onValueChange={setTheme} />
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" onClick={onLogout}>
                      <LogOutIcon />
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel
                    className="flex items-center justify-between gap-4"
                    title={buildCommit}
                  >
                    <span>版本</span>
                    <code className="font-mono font-normal text-muted-foreground">
                      {buildVersion}
                    </code>
                  </DropdownMenuLabel>
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
          <p className="text-sm font-medium">
            {items.find((item) => item.id === page)?.label}
          </p>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="选择主题"
                  />
                }
              >
                {theme === "light" ? (
                  <SunIcon />
                ) : theme === "dark" ? (
                  <MoonIcon />
                ) : (
                  <MonitorIcon />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>外观</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <ThemeChoices value={theme} onValueChange={setTheme} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex flex-1 flex-col p-4 pt-0 sm:p-6 sm:pt-0">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
