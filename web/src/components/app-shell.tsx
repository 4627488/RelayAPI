import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell"
import { Avatar } from "@astryxdesign/core/Avatar"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { Icon } from "@astryxdesign/core/Icon"
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav"
import { Text } from "@astryxdesign/core/Text"
import { VStack } from "@astryxdesign/core/Layout"
import {
  BarChart3Icon,
  BookOpenIcon,
  GaugeIcon,
  KeyRoundIcon,
  ListIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PackageOpenIcon,
  PlugIcon,
  SendIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react"

import { useColorMode, type ColorMode } from "@/components/app-providers"
import type { Session } from "@/lib/api"

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
  { id: "overview", label: "管理总览", icon: GaugeIcon, section: "运营" },
  { id: "users", label: "用户", icon: UsersIcon, section: "运营" },
  {
    id: "subscriptions",
    label: "订阅分配",
    icon: PackageOpenIcon,
    section: "运营",
  },
  { id: "usage", label: "全局用量", icon: BarChart3Icon, section: "运营" },
  { id: "logs", label: "请求日志", icon: ListIcon, section: "运营" },
  { id: "providers", label: "模型管理", icon: PlugIcon, section: "上游" },
  { id: "pricing", label: "模型设置", icon: Settings2Icon, section: "上游" },
  {
    id: "settings",
    label: "系统设置",
    icon: SlidersHorizontalIcon,
    section: "上游",
  },
]

function navPage(page: Page): Page {
  if (page === "invitations") return "users"
  if (page === "proxies") return "settings"
  return page
}

function EmailAvatar({ email, name }: { email: string; name: string }) {
  const [source, setSource] = useState("")

  useEffect(() => {
    let active = true
    const normalized = email.trim().toLowerCase()
    setSource("")
    if (!normalized || !globalThis.crypto?.subtle) {
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
    <Avatar src={source || undefined} name={name} size="sm" />
  )
}

const themeItems: Array<{
  value: ColorMode
  label: string
  icon: ComponentType
}> = [
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
  { value: "system", label: "跟随系统", icon: MonitorIcon },
]

const buildCommit = (import.meta.env.VITE_GIT_COMMIT || "dev").trim()
const buildVersion =
  buildCommit === "dev" ? buildCommit : buildCommit.slice(0, 7)

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
  const { mode, setMode } = useColorMode()
  const admin = workspace === "admin" && session.is_admin
  const name = session.tenant.name || "用户"
  const subtitle = session.tenant.owner_email || ""
  const items = admin ? adminItems : userItems
  const active = navPage(page)

  const groups: { title: string; items: NavigationItem[] }[] = []
  for (const item of items) {
    const title = item.section || "工作区"
    const last = groups.at(-1)
    if (last && last.title === title) last.items.push(item)
    else groups.push({ title, items: [item] })
  }

  return (
    <AstryxAppShell
      height="fill"
      variant="elevated"
      contentPadding={4}
      sideNav={
        <SideNav
          collapsible
          resizable={{ defaultWidth: 260, minWidth: 220, maxWidth: 320 }}
          header={
            <SideNavHeading
              heading="RelayAPI"
              subheading="模型网关"
              icon={<Icon icon={SendIcon} />}
            />
          }
          footer={
            <DropdownMenu
              placement="above"
              alignment="start"
              hasChevron
              menuWidth={240}
              button={{
                label: name,
                variant: "ghost",
                width: "100%",
                icon: <EmailAvatar email={subtitle} name={name} />,
              }}
              items={[
                { type: "section", title: name, items: [] },
                ...(session.is_admin
                  ? [
                      {
                        label: admin ? "返回个人面板" : "进入管理员面板",
                        icon: admin ? (
                          <UserRoundIcon />
                        ) : (
                          <ShieldCheckIcon />
                        ),
                        onClick: () =>
                          onWorkspaceChange(admin ? "user" : "admin"),
                      },
                      { type: "divider" as const },
                    ]
                  : []),
                {
                  type: "section",
                  title: "外观",
                  items: themeItems.map((item) => ({
                    label: item.label,
                    icon: <item.icon />,
                    onClick: () => setMode(item.value),
                    endContent:
                      mode === item.value ? <Text type="supporting">当前</Text> : undefined,
                  })),
                },
                { type: "divider" },
                {
                  label: "退出登录",
                  icon: <LogOutIcon />,
                  variant: "destructive" as const,
                  onClick: onLogout,
                },
                { type: "divider" },
                {
                  label: `版本 ${buildVersion}`,
                  isDisabled: true,
                },
              ]}
            />
          }
        >
          {groups.map((group) => (
            <SideNavSection key={group.title} title={group.title}>
              {group.items.map((item) => (
                <SideNavItem
                  key={item.id}
                  label={item.label}
                  icon={item.icon}
                  isSelected={active === item.id}
                  onClick={() => onPageChange(item.id)}
                />
              ))}
            </SideNavSection>
          ))}
        </SideNav>
      }
    >
      <VStack gap={4}>{children}</VStack>
    </AstryxAppShell>
  )
}
