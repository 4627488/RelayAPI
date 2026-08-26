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
import {
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SendIcon,
  ShieldCheckIcon,
  SunIcon,
  UserRoundIcon,
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
}

const userItems: NavigationItem[] = [
  { id: "overview", label: "工作台" },
  { id: "keys", label: "密钥" },
  { id: "usage", label: "用量" },
  { id: "logs", label: "日志" },
]

const adminItems: Array<NavigationItem & { section: string }> = [
  { id: "overview", label: "工作台", section: "运营" },
  { id: "users", label: "用户", section: "运营" },
  { id: "usage", label: "用量", section: "运营" },
  { id: "logs", label: "日志", section: "运营" },
  { id: "providers", label: "模型", section: "上游" },
  { id: "pricing", label: "定价", section: "上游" },
  { id: "subscriptions", label: "订阅", section: "上游" },
  { id: "settings", label: "设置", section: "上游" },
]

function navPage(page: Page): Page {
  if (page === "invitations") return "users"
  if (page === "proxies") return "settings"
  if (page === "guide") return "keys"
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

  return <Avatar src={source || undefined} name={name} size="sm" />
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
  const active = navPage(page)

  return (
    <AstryxAppShell
      height="fill"
      variant="section"
      contentPadding={0}
      sideNav={
        <SideNav
          collapsible
          resizable={{
            defaultWidth: 240,
            minWidth: 200,
            maxWidth: 300,
            autoSaveId: "relayapi.sidenav",
          }}
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
                      mode === item.value ? (
                        <Text type="supporting">当前</Text>
                      ) : undefined,
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
          {admin ? (
            <>
              <SideNavSection title="运营">
                {adminItems
                  .filter((item) => item.section === "运营")
                  .map((item) => (
                    <SideNavItem
                      key={item.id}
                      label={item.label}
                      isSelected={active === item.id}
                      onClick={() => onPageChange(item.id)}
                    />
                  ))}
              </SideNavSection>
              <SideNavSection title="上游">
                {adminItems
                  .filter((item) => item.section === "上游")
                  .map((item) => (
                    <SideNavItem
                      key={item.id}
                      label={item.label}
                      isSelected={active === item.id}
                      onClick={() => onPageChange(item.id)}
                    />
                  ))}
              </SideNavSection>
            </>
          ) : (
            <SideNavSection title="工作区">
              {userItems.map((item) => (
                <SideNavItem
                  key={item.id}
                  label={item.label}
                  isSelected={active === item.id}
                  onClick={() => onPageChange(item.id)}
                />
              ))}
            </SideNavSection>
          )}
        </SideNav>
      }
    >
      {children}
    </AstryxAppShell>
  )
}
