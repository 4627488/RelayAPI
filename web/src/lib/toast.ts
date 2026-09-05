import { createKumoToastManager } from "@cloudflare/kumo/components/toast"

export const toastManager = createKumoToastManager()

function notify(
  title: string,
  variant: "default" | "success" | "error" | "warning" | "info" = "default"
) {
  toastManager.add({ title, variant })
}

export const toast = {
  message: (title: string) => notify(title),
  success: (title: string) => notify(title, "success"),
  error: (title: string) => notify(title, "error"),
  warning: (title: string) => notify(title, "warning"),
  info: (title: string) => notify(title, "info"),
}

export function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
