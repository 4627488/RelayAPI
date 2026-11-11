import { useState } from "react"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"

export function MagpieImportButton({ keyID }: { keyID: string }) {
  const [pending, setPending] = useState(false)

  async function importKey() {
    setPending(true)
    try {
      const { href } = await api<{ href: string }>(
        `/api/keys/${encodeURIComponent(keyID)}/magpie`
      )
      window.location.assign(href)
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "无法导入 Magpie",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      aria-label="Add to magpie"
      aria-busy={pending}
      disabled={pending}
      onClick={() => void importKey()}
      className="shrink-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50"
    >
      <img
        src="/magpie/add-to-magpie.svg"
        alt="Add to magpie"
        width="176"
        height="40"
        className="block dark:hidden"
      />
      <img
        src="/magpie/add-to-magpie-light.svg"
        alt=""
        width="176"
        height="40"
        className="hidden dark:block"
      />
    </button>
  )
}
