import { useCallback, useSyncExternalStore } from "react"

const changeEvent = "relayapi:inbox-change"
const memory = new Map<string, string>()
const memoryOnly = new Set<string>()

function subscribe(onChange: () => void) {
  window.addEventListener(changeEvent, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(changeEvent, onChange)
    window.removeEventListener("storage", onChange)
  }
}

function snapshot(key: string) {
  if (memoryOnly.has(key)) return memory.get(key) || "[]"
  try {
    return window.localStorage.getItem(key) || "[]"
  } catch {
    return memory.get(key) || "[]"
  }
}

function parseReadIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

export function useReleaseInbox(accountId: string) {
  const key = `relayapi.inbox.v1.${accountId}`
  const getSnapshot = useCallback(() => snapshot(key), [key])
  const value = useSyncExternalStore(subscribe, getSnapshot)
  const readIds = new Set(parseReadIds(value))

  const markRead = useCallback(
    (ids: string[]) => {
      const next = JSON.stringify([
        ...new Set([...parseReadIds(snapshot(key)), ...ids]),
      ])
      memory.set(key, next)
      try {
        window.localStorage.setItem(key, next)
      } catch {
        memoryOnly.add(key)
        // Keep the inbox usable in memory when browser storage is unavailable.
      }
      window.dispatchEvent(new Event(changeEvent))
    },
    [key]
  )

  return { readIds, markRead }
}
