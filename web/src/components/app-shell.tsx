import {
  useEffect,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react"
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
  PackageOpenIcon,
  Settings2Icon,
  PlugIcon,
  SendIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { isTheme, useTheme, type Theme } from "@/components/theme-provider"
import type { Session } from "@/lib/api"
import { initials } from "@/lib/format"
import { routeHref, type Page, type Workspace } from "@/lib/routes"

interface NavigationItem {
  id: Page
  label: string
  icon: ComponentType
  section?: string
}

const userItems: NavigationItem[] = [
  { id: "overview", label: "总览", icon: GaugeIcon },
  { id: "usage", label: "用量", icon: BarChart3Icon },
  { id: "keys", label: "API Keys", icon: KeyRoundIcon },
  { id: "guide", label: "接入指南", icon: BookOpenIcon },
  { id: "subscriptions", label: "我的订阅", icon: PackageOpenIcon },
  { id: "logs", label: "请求日志", icon: ListIcon },
]

const adminItems: NavigationItem[] = [
  { id: "overview", label: "管理总览", icon: GaugeIcon, section: "管理" },
  { id: "users", label: "用户", icon: UsersIcon, section: "管理" },
  { id: "providers", label: "模型账户", icon: PlugIcon, section: "模型" },
  {
    id: "subscriptions",
    label: "订阅分配",
    icon: PackageOpenIcon,
    section: "模型",
  },
  { id: "pricing", label: "目录与计费", icon: Settings2Icon, section: "模型" },
  {
    id: "settings",
    label: "系统设置",
    icon: SlidersHorizontalIcon,
    section: "模型",
  },
  { id: "usage", label: "全局用量", icon: BarChart3Icon, section: "观测" },
  { id: "logs", label: "请求日志", icon: ListIcon, section: "观测" },
]

function navPage(page: Page): Page {
  if (page === "invitations") return "users"
  if (page === "proxies") return "settings"
  return page
}

function shouldHandleClientNavigation(event: MouseEvent<HTMLElement>) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

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

function SidebarNav({
  items,
  workspace,
  page,
  fallbackLabel,
  onPageChange,
}: {
  items: NavigationItem[]
  workspace: Workspace
  page: Page
  fallbackLabel: string
  onPageChange: (page: Page) => void
}) {
  const groups: { title: string; items: NavigationItem[] }[] = []
  for (const item of items) {
    const title = item.section || fallbackLabel
    const last = groups.at(-1)
    if (last && last.title === title) last.items.push(item)
    else groups.push({ title, items: [item] })
  }
  const active = navPage(page)

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    render={
                      <a href={routeHref({ workspace, page: item.id })} />
                    }
                    isActive={active === item.id}
                    tooltip={item.label}
                    onClick={(event) => {
                      if (!shouldHandleClientNavigation(event)) return
                      event.preventDefault()
                      onPageChange(item.id)
                    }}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
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
                render={<a href={routeHref({ workspace, page: "overview" })} />}
                size="lg"
                onClick={(event) => {
                  if (!shouldHandleClientNavigation(event)) return
                  event.preventDefault()
                  onPageChange("overview")
                }}
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
          <SidebarNav
            items={items}
            workspace={workspace}
            page={page}
            fallbackLabel="工作区"
            onPageChange={onPageChange}
          />
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
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center border-b bg-background px-3 md:hidden">
          <SidebarTrigger />
        </header>
        <main className="mx-auto flex w-full max-w-[1440px] min-w-0 flex-1 flex-col p-3 sm:p-5">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
