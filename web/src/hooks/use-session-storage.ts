import { useCallback, useState } from "react"

export function useSessionStorage<T>(
  key: string,
  validate: (value: unknown) => value is T,
) {
  const [value, setValueState] = useState<T | null>(() => {
    try {
      const stored = window.sessionStorage.getItem(key)
      if (!stored) return null

      const parsed: unknown = JSON.parse(stored)
      if (validate(parsed)) return parsed

      window.sessionStorage.removeItem(key)
    } catch {
      // Storage may be unavailable in hardened/private browser contexts.
    }

    return null
  })

  const setValue = useCallback((nextValue: T | null) => {
    setValueState(nextValue)
    try {
      if (nextValue === null) {
        window.sessionStorage.removeItem(key)
      } else {
        window.sessionStorage.setItem(key, JSON.stringify(nextValue))
      }
    } catch {
      // Keep the in-memory value even when storage is unavailable.
    }
  }, [key])

  return [value, setValue] as const
}
