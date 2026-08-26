import { playwright } from "@vitest/browser-playwright"
import { mergeConfig } from "vite"
import { defineConfig } from "vitest/config"

import viteConfig from "./vite.config"

export default mergeConfig(
  viteConfig,
  defineConfig({
    optimizeDeps: {
      include: [
        "@base-ui/react/avatar",
        "@base-ui/react/dialog",
        "@base-ui/react/menu",
        "@base-ui/react/merge-props",
        "@base-ui/react/separator",
        "@base-ui/react/tooltip",
        "@base-ui/react/toggle",
        "@base-ui/react/toggle-group",
        "@base-ui/react/use-render",
        "sonner",
      ],
    },
    test: {
      include: ["src/**/*.browser.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
      unstubGlobals: true,
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        trace: "retain-on-failure",
        viewport: { width: 1280, height: 800 },
        instances: [{ browser: "chromium" }],
      },
    },
  })
)
