import { lazy, Suspense, useEffect, useState } from "react"
import { toast } from "sonner"

import { AppShell, type Page } from "@/components/app-shell"
import { AuthPage } from "@/components/auth-page"
import { LoadingView } from "@/components/loading-view"
import { api, type Session } from "@/lib/api"

const AdminWorkspace = lazy(() =>
  import("@/components/admin-workspace").then((module) => ({ default: module.AdminWorkspace })),
)
const UserWorkspace = lazy(() =>
  import("@/components/user-workspace").then((module) => ({ default: module.UserWorkspace })),
)

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState<Page>("overview")

  useEffect(() => {
    api<Session>("/api/me")
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false))
  }, [])

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" })
      setSession(null)
      setPage("overview")
      toast.success("已退出登录")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "退出失败")
    }
  }

  if (checking) {
    return <main className="p-6"><LoadingView /></main>
  }

  if (!session) {
    return <AuthPage onAuthenticated={(value) => { setSession(value); setPage("overview") }} />
  }

  return (
    <AppShell
      session={session}
      page={page}
      onPageChange={setPage}
      onLogout={() => void logout()}
    >
      <Suspense fallback={<LoadingView />}>
        {session.role === "admin" ? (
          <AdminWorkspace page={page} />
        ) : (
          <UserWorkspace page={page} session={session} />
        )}
      </Suspense>
    </AppShell>
  )
}

export default App
