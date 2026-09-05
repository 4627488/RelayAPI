import { useEffect, useState } from "react"

import { AuthPage } from "@/console/auth"
import { ForcePasswordChange } from "@/console/password"
import { AppShell } from "@/console/shell"
import { Workspace } from "@/console/workspace"
import { LoadingState } from "@/console/kit"
import { api, type Session } from "@/lib/api"
import { navigateTo, useAppRoute } from "@/lib/routes"
import { errorMessage, toast } from "@/lib/toast"

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
      setSession(null)
      navigateTo({ workspace: "user", page: "overview" }, { replace: true })
      toast.success("已退出登录")
    } catch (cause) {
      toast.error(errorMessage(cause, "退出失败"))
    }
  }

  if (checking) {
    return (
      <main className="p-6">
        <LoadingState />
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
      <Workspace
        session={session}
        page={route.page}
        logId={route.logId}
        admin={route.workspace === "admin" && session.is_admin}
        onPageChange={(page, logId) =>
          navigateTo({ workspace: route.workspace, page, logId })
        }
      />
    </AppShell>
  )
}

export default App
