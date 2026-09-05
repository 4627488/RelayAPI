import { lazy, useCallback, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { PageHeader } from "@/components/workspace-ui"
import { api, type Invitation, type User } from "@/lib/api"
import { useAsyncResource } from "@/hooks/use-async-resource"

const UsersView = lazy(() =>
  import("@/components/admin/users-view").then((module) => ({
    default: module.UsersView,
  }))
)
const InvitationsView = lazy(() =>
  import("@/components/admin/invitations-view").then((module) => ({
    default: module.InvitationsView,
  }))
)

export function UsersHub({
  currentUserId,
  tab,
  onTabChange,
}: {
  currentUserId: string
  tab: "accounts" | "invites"
  onTabChange: (tab: "accounts" | "invites") => void
}) {
  const [now] = useState(() => Date.now())
  const loadUsers = useCallback(async () => {
    const [users, invitations] = await Promise.all([
      api<{ items: User[] }>("/api/admin/tenants"),
      api<{ items: Invitation[] }>("/api/admin/invitations"),
    ])
    return {
      users: users.items ?? [],
      invitations: invitations.items ?? [],
    }
  }, [])
  const {
    data: { users, invitations },
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadUsers, {
    initialData: { users: [] as User[], invitations: [] as Invitation[] },
    errorMessage: "无法读取用户数据",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })

  if (loading) return <LoadingView />
  if (loadError && users.length === 0 && invitations.length === 0) {
    return (
      <LoadErrorView message={loadError} onRetry={() => void reload(true)} />
    )
  }

  const pendingInvites = invitations.filter((item) => {
    const expired = new Date(item.expires_at).getTime() <= now
    return !item.used_at && !item.revoked_at && !expired
  }).length

  return (
    <div className="flex flex-col gap-4">
      {tab === "accounts" ? (
        <PageHeader
          title="用户"
          description="管理登录权限、额度与账户生命周期。"
        />
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "accounts" || value === "invites") onTabChange(value)
        }}
      >
        <TabsList>
          <TabsTrigger value="accounts">账号</TabsTrigger>
          <TabsTrigger value="invites">
            邀请
            {pendingInvites > 0 ? (
              <Badge variant="secondary">{pendingInvites}</Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "accounts" ? (
        <UsersView
          users={users}
          currentUserId={currentUserId}
          onChanged={() => reload()}
        />
      ) : (
        <InvitationsView items={invitations} onChanged={() => reload()} />
      )}
    </div>
  )
}
