import type { ComponentType, MouseEvent, ReactNode } from "react"
import {
  ChartBarIcon,
  GearIcon,
  HouseIcon,
  KeyIcon,
  ListBulletsIcon,
  PackageIcon,
  PaperPlaneTiltIcon,
  PlugsIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SlidersIcon,
  BookOpenIcon,
  UsersIcon,
  UserIcon,
} from "@phosphor-icons/react"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { Sidebar } from "@cloudflare/kumo/components/sidebar"
import { isTheme, useTheme, type Theme } from "@/lib/theme"
import type { Session } from "@/lib/api"
import { routeHref, type Page, type Workspace } from "@/lib/routes"

interface NavItem {
  id: Page
  label: string
  icon: ComponentType<{ className?: string }>
  section?: string
}

const userItems: NavItem[] = [
  { id: "overview", label: "总览", icon: HouseIcon },
  { id: "usage", label: "用量", icon: ChartBarIcon },
  { id: "keys", label: "API Keys", icon: KeyIcon },
  { id: "guide", label: "接入指南", icon: BookOpenIcon },
  { id: "subscriptions", label: "我的订阅", icon: PackageIcon },
  { id: "logs", label: "请求日志", icon: ListBulletsIcon },
]

const adminItems: NavItem[] = [
  { id: "overview", label: "管理总览", icon: HouseIcon, section: "管理" },
  { id: "users", label: "用户", icon: UsersIcon, section: "管理" },
  { id: "providers", label: "模型账户", icon: PlugsIcon, section: "模型" },
  {
    id: "subscriptions",
    label: "订阅分配",
    icon: PackageIcon,
    section: "模型",
  },
  { id: "pricing", label: "目录与计费", icon: GearIcon, section: "模型" },
  { id: "settings", label: "系统设置", icon: SlidersIcon, section: "模型" },
  { id: "usage", label: "全局用量", icon: ChartBarIcon, section: "观测" },
  { id: "logs", label: "请求日志", icon: ListBulletsIcon, section: "观测" },
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

const themes: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
]

const buildCommit = (import.meta.env.VITE_GIT_COMMIT || "dev").trim()
const buildVersion =
  buildCommit === "dev" ? buildCommit : buildCommit.slice(0, 7)

export function AppShell({
  session,
  workspace,
  page,
  onPageChange,
  onWorkspaceChange,
  onLogout,
  children,
}: {
  session: Session
  workspace: Workspace
  page: Page
  onPageChange: (page: Page) => void
  onWorkspaceChange: (workspace: Workspace) => void
  onLogout: () => void
  children: ReactNode
}) {
  const { theme, setTheme } = useTheme()
  const admin = workspace === "admin" && session.is_admin
  const name = session.tenant.name || "用户"
  const email = session.tenant.owner_email || ""
  const items = admin ? adminItems : userItems
  const groups: { title: string; items: NavItem[] }[] = []
  for (const item of items) {
    const title = item.section || "工作区"
    const last = groups.at(-1)
    if (last && last.title === title) last.items.push(item)
    else groups.push({ title, items: [item] })
  }
  const active = navPage(page)

  return (
    <Sidebar.Provider defaultOpen>
      <Sidebar>
        <Sidebar.Header>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              href={routeHref({ workspace, page: "overview" })}
              icon={PaperPlaneTiltIcon}
              onClick={(event) => {
                if (!shouldHandleClientNavigation(event)) return
                event.preventDefault()
                onPageChange("overview")
              }}
            >
              RelayAPI
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Header>
        <Sidebar.Content>
          {groups.map((group) => (
            <Sidebar.Group key={group.title}>
              <Sidebar.GroupLabel>{group.title}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {group.items.map((item) => (
                  <Sidebar.MenuButton
                    key={item.id}
                    href={routeHref({ workspace, page: item.id })}
                    icon={item.icon}
                    active={active === item.id}
                    tooltip={item.label}
                    onClick={(event) => {
                      if (!shouldHandleClientNavigation(event)) return
                      event.preventDefault()
                      onPageChange(item.id)
                    }}
                  >
                    {item.label}
                  </Sidebar.MenuButton>
                ))}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
        <Sidebar.Footer>
          <Sidebar.Menu>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Sidebar.MenuButton
                    icon={admin ? ShieldCheckIcon : UserIcon}
                  />
                }
              >
                {name}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Group>
                  <DropdownMenu.Label>{email || name}</DropdownMenu.Label>
                </DropdownMenu.Group>
                {session.is_admin ? (
                  <DropdownMenu.Item
                    onClick={() => onWorkspaceChange(admin ? "user" : "admin")}
                  >
                    {admin ? "返回个人面板" : "进入管理员面板"}
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Separator />
                <DropdownMenu.RadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    if (isTheme(value)) setTheme(value)
                  }}
                >
                  {themes.map((item) => (
                    <DropdownMenu.RadioItem key={item.value} value={item.value}>
                      {item.label}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onClick={onLogout}>
                  <SignOutIcon />
                  退出登录
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Label>版本 {buildVersion}</DropdownMenu.Label>
              </DropdownMenu.Content>
            </DropdownMenu>
          </Sidebar.Menu>
          <Sidebar.Trigger />
        </Sidebar.Footer>
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center border-b border-kumo-hairline bg-kumo-canvas px-3 md:hidden">
          <Sidebar.Trigger />
        </header>
        <main className="mx-auto flex w-full max-w-[1440px] min-w-0 flex-1 flex-col p-4 sm:p-6">
          {children}
        </main>
      </div>
    </Sidebar.Provider>
  )
}
