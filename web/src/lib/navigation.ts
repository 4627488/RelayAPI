import type { ComponentType } from "react"
import {
  BarChart3Icon,
  BookOpenIcon,
  GaugeIcon,
  KeyRoundIcon,
  ListIcon,
  PackageOpenIcon,
  PlugIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react"

import type { Page, Workspace } from "@/lib/routes"

export interface NavigationItem {
  id: Page
  label: string
  icon: ComponentType
  section: string
}

export const userNavigation: NavigationItem[] = [
  { id: "overview", label: "总览", icon: GaugeIcon, section: "开始使用" },
  { id: "guide", label: "接入指南", icon: BookOpenIcon, section: "开始使用" },
  { id: "keys", label: "API 密钥", icon: KeyRoundIcon, section: "开始使用" },
  { id: "usage", label: "用量", icon: BarChart3Icon, section: "运行与观测" },
  { id: "logs", label: "请求日志", icon: ListIcon, section: "运行与观测" },
  {
    id: "subscriptions",
    label: "我的订阅",
    icon: PackageOpenIcon,
    section: "账户",
  },
]

export const adminNavigation: NavigationItem[] = [
  { id: "overview", label: "管理总览", icon: GaugeIcon, section: "管理" },
  { id: "users", label: "用户", icon: UsersIcon, section: "管理" },
  { id: "providers", label: "模型账户", icon: PlugIcon, section: "模型与计费" },
  {
    id: "subscriptions",
    label: "订阅分配",
    icon: PackageOpenIcon,
    section: "模型与计费",
  },
  {
    id: "pricing",
    label: "目录与计费",
    icon: Settings2Icon,
    section: "模型与计费",
  },
  {
    id: "settings",
    label: "系统设置",
    icon: SlidersHorizontalIcon,
    section: "模型与计费",
  },
  { id: "usage", label: "全局用量", icon: BarChart3Icon, section: "观测" },
  { id: "logs", label: "请求日志", icon: ListIcon, section: "观测" },
]

export const workspaceLabels: Record<Workspace, string> = {
  user: "个人工作台",
  admin: "管理员工作区",
}

export const pageLabels: Partial<Record<Page, string>> = {
  overview: "总览",
  usage: "用量",
  keys: "API Keys",
  logs: "请求日志",
  guide: "接入指南",
  users: "用户",
  invitations: "邀请管理",
  providers: "模型账户",
  proxies: "出站代理",
  settings: "系统设置",
  subscriptions: "我的订阅",
  pricing: "目录与计费",
}

export const adminPageLabels: Partial<Record<Page, string>> = {
  ...pageLabels,
  overview: "管理总览",
  usage: "全局用量",
  subscriptions: "订阅分配",
}
