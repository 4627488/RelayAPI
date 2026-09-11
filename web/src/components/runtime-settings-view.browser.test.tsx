import { expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { RuntimeSettingsView } from "@/components/runtime-settings-view"
import { api } from "@/lib/api"

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}))

it("saves RAI candidate order and allows disabling automatic selection", async () => {
  let settings = {
    rai_default_models: ["gpt-5.6-sol", "grok-4.6"],
    routing_strategy: "round-robin",
    credential_failure_threshold: 3,
    credential_cooldown_seconds: 0,
    system_proxy_id: "",
    request_timeout_seconds: 86400,
    max_request_mib: 1024,
    request_bytes_in_flight_mib: 8192,
    memory_reclaim_threshold_mib: 8192,
    unpriced_model_policy: "allow",
    upstream_websockets: true,
    request_retry: 2,
    max_retry_credentials: 0,
    max_retry_interval: 30,
    disable_credential_cooling: true,
    passthrough_headers: true,
    image_generation_mode: "enabled",
    gpt_image_base_model: "gpt-5.4-mini",
    video_result_auth_cache_ttl: "3h",
    force_model_prefix: false,
    stream_keepalive_seconds: 15,
    stream_bootstrap_retries: 1,
    nonstream_keepalive_interval: 0,
  }
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/admin/proxies") return { items: [] }
    if (init?.method === "PATCH") settings = JSON.parse(String(init.body))
    return {
      mode: "embedded_cpa",
      settings,
      runtime: {
        ready: true,
        credentials: 2,
        models: 3,
        max_in_flight: 10,
        max_queue: 10,
      },
    }
  })
  const screen = await render(<RuntimeSettingsView />)
  const input = screen.getByRole("textbox", { name: "候选模型" })
  await expect.element(input).toHaveValue("gpt-5.6-sol\ngrok-4.6")
  await input.fill("grok-4.6\n custom-model \n")
  await screen.getByRole("button", { name: "保存", exact: true }).click()
  await expect.element(input).toHaveValue("grok-4.6\ncustom-model")
  expect(settings.rai_default_models).toEqual(["grok-4.6", "custom-model"])
  await input.fill("")
  await screen.getByRole("button", { name: "保存", exact: true }).click()
  await expect
    .element(screen.getByRole("button", { name: "保存", exact: true }))
    .not.toBeInTheDocument()
  expect(settings.rai_default_models).toEqual([])
})
