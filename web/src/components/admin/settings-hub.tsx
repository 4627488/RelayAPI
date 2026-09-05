import { PageHeader } from "@/components/workspace-ui"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProxiesView } from "@/components/proxies-view"
import { RuntimeSettingsView } from "@/components/runtime-settings-view"

export function SettingsHub({
  tab,
  onTabChange,
}: {
  tab: "runtime" | "proxies"
  onTabChange: (tab: "runtime" | "proxies") => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {tab === "runtime" ? <PageHeader title="系统设置" /> : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "runtime" || value === "proxies") onTabChange(value)
        }}
      >
        <TabsList>
          <TabsTrigger value="runtime">运行策略</TabsTrigger>
          <TabsTrigger value="proxies">出站代理</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "runtime" ? <RuntimeSettingsView /> : <ProxiesView />}
    </div>
  )
}
