import { lazy, Suspense, useEffect, useState } from "react"
import { toast } from "@/components/ui/toast"

import { AppShell } from "@/components/app-shell"
import { AuthPage } from "@/components/auth-page"
import { ForcePasswordChange } from "@/components/force-password-change"
import { LoadingView } from "@/components/loading-view"
import { api, type Session } from "@/lib/api"
import { navigateTo, useAppRoute } from "@/lib/routes"

const AdminWorkspace = lazy(() =>
  import("@/components/admin-workspace").then((module) => ({
    default: module.AdminWorkspace,
  }))
)
const UserWorkspace = lazy(() =>
  import("@/components/user-workspace").then((module) => ({
    default: module.UserWorkspace,
  }))
)

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const route = useAppRoute()

  useEffect(() => {
    api<Session>("/api/me")
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    if (checking || !session) return
    if (!route.valid || (route.workspace === "admin" && !session.is_admin)) {
      navigateTo(
        route.workspace === "admin" && session.is_admin
          ? {
              workspace: "admin",
              page: route.page,
              logId: route.logId,
            }
          : { workspace: "user", page: "overview" },
        { replace: true }
      )
    }
  }, [checking, route, session])

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" })
      try {
        for (
          let index = window.sessionStorage.length - 1;
          index >= 0;
          index -= 1
        ) {
          const key = window.sessionStorage.key(index)
          if (key?.startsWith("relayapi.latest-"))
            window.sessionStorage.removeItem(key)
        }
      } catch {
        // Session storage may be disabled; logout must still succeed.
      }
      setSession(null)
      navigateTo({ workspace: "user", page: "overview" }, { replace: true })
      toast.add({ title: "已退出登录", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "退出失败",
        type: "error",
      })
    }
  }

  if (checking) {
    return (
      <main className="p-6">
        <LoadingView />
      </main>
    )
  }

  if (!session) {
    return (
      <AuthPage
        onAuthenticated={(value) => {
          setSession(value)
          navigateTo({ workspace: "user", page: "overview" }, { replace: true })
        }}
      />
    )
  }

  if (session.tenant.must_change_password) {
    return (
      <ForcePasswordChange
        onChanged={async () => setSession(await api<Session>("/api/me"))}
        onLogout={() => void logout()}
      />
    )
  }

  return (
    <AppShell
      session={session}
      workspace={route.workspace}
      page={route.page}
      onPageChange={(page) => navigateTo({ workspace: route.workspace, page })}
      onWorkspaceChange={(value) => {
        navigateTo({ workspace: value, page: "overview" })
      }}
      onLogout={() => void logout()}
    >
      <Suspense fallback={<LoadingView />}>
        {route.workspace === "admin" && session.is_admin ? (
          <AdminWorkspace
            page={route.page}
            currentUserId={session.tenant.id}
            onPageChange={(page) => navigateTo({ workspace: "admin", page })}
          />
        ) : (
          <UserWorkspace
            page={route.page}
            session={session}
            onPageChange={(page) => navigateTo({ workspace: "user", page })}
          />
        )}
      </Suspense>
    </AppShell>
  )
}

export default App
