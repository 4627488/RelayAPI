import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toasty } from "@cloudflare/kumo/components/toast"

import "./index.css"
import App from "./App.tsx"
import { ErrorBoundary } from "@/console/error-boundary"
import { ThemeProvider } from "@/lib/theme"
import { toastManager } from "@/lib/toast"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Toasty toastManager={toastManager}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </Toasty>
    </ThemeProvider>
  </StrictMode>
)
