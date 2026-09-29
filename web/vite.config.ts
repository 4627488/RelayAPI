import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const apiProxy = {
  target: process.env.RELAY_DEMO_API_TARGET || "http://localhost:3000",
  changeOrigin: true,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": apiProxy,
      "/healthz": apiProxy,
      "/v1": apiProxy,
      "/rai/install": apiProxy,
      "/rai/download": apiProxy,
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
})
