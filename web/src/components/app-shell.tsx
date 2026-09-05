import {
  useEffect,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  ChevronRightIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SendIcon,
  ShieldCheckIcon,
  SunIcon,
  UserRoundIcon,
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
  useSidebar,
} from "@/components/ui/sidebar"
import { isTheme, useTheme, type Theme } from "@/components/theme-provider"
import type { Session } from "@/lib/api"
import {
  adminNavigation,
  adminPageLabels,
  type NavigationItem,
  pageLabels,
  userNavigation,
  workspaceLabels,
} from "@/lib/navigation"
import { routeHref, type Page, type Workspace } from "@/lib/routes"

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
    <Avatar className="size-8">
      {source ? <AvatarImage src={source} alt={`${name} 的头像`} /> : null}
      <AvatarFallback>
        <UserRoundIcon aria-hidden="true" />
      </AvatarFallback>
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
  const { isMobile, setOpenMobile } = useSidebar()
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
                    aria-current={active === item.id ? "page" : undefined}
                    tooltip={item.label}
                    onClick={(event) => {
                      if (!shouldHandleClientNavigation(event)) return
                      event.preventDefault()
                      onPageChange(item.id)
                      if (isMobile) setOpenMobile(false)
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
  const items = admin ? adminNavigation : userNavigation
  const workspaceActionLabel = admin ? "返回个人面板" : "进入管理员面板"
  const currentPageLabel =
    (admin ? adminPageLabels : pageLabels)[navPage(page)] || "总览"

  return (
    <SidebarProvider>
      <a className="sr-only focus:not-sr-only" href="#main-content">
        跳到主内容
      </a>
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
                <SendIcon />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">RelayAPI</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {workspaceLabels[workspace]}
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
      <SidebarInset id="main-content" tabIndex={-1} className="min-w-0">
        <header
          aria-label="当前位置"
          className="sticky top-0 z-10 flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3 sm:px-5"
        >
          <div className="flex min-w-0 items-center gap-1">
            <SidebarTrigger />
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {workspaceLabels[workspace]}
              </span>
              <ChevronRightIcon className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:inline" />
              <span className="truncate font-medium">{currentPageLabel}</span>
            </div>
          </div>
          {session.is_admin ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onWorkspaceChange(admin ? "user" : "admin")}
              aria-label={workspaceActionLabel}
            >
              {admin ? (
                <UserRoundIcon data-icon="inline-start" />
              ) : (
                <ShieldCheckIcon data-icon="inline-start" />
              )}
              <span className="hidden sm:inline">{workspaceActionLabel}</span>
            </Button>
          ) : null}
        </header>
        <div className="mx-auto flex w-full max-w-[1440px] min-w-0 flex-1 flex-col p-4 sm:p-6 lg:p-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
