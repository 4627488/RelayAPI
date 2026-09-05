import { playwright } from "@vitest/browser-playwright"
import { mergeConfig } from "vite"
import { defineConfig } from "vitest/config"

import viteConfig from "./vite.config"

export default mergeConfig(
  viteConfig,
  defineConfig({
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
