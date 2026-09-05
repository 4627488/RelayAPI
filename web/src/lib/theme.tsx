import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const THEME_VALUES: Theme[] = ["dark", "light", "system"]

const ThemeContext = createContext<
  { theme: Theme; setTheme: (theme: Theme) => void } | undefined
>(undefined)

export function isTheme(value: unknown): value is Theme {
  return THEME_VALUES.includes(value as Theme)
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(COLOR_SCHEME_QUERY).matches ? "dark" : "light"
}

function applyMode(theme: Theme) {
  const resolved = theme === "system" ? systemTheme() : theme
  const root = document.documentElement
  root.dataset.mode = resolved
  root.classList.remove("light", "dark")
  root.classList.add(resolved)
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
}: {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey)
    return isTheme(stored) ? stored : defaultTheme
  })

  const setTheme = useCallback(
    (next: Theme) => {
      if (!isTheme(next)) return
      localStorage.setItem(storageKey, next)
      setThemeState(next)
    },
    [storageKey]
  )

  useEffect(() => {
    applyMode(theme)
    if (theme !== "system") return
    const media = window.matchMedia(COLOR_SCHEME_QUERY)
    const onChange = () => applyMode("system")
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [theme])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable='true']"))
      ) {
        return
      }
      if (event.key.toLowerCase() !== "d") return
      setThemeState((current) => {
        const next =
          current === "dark"
            ? "light"
            : current === "light"
              ? "dark"
              : systemTheme() === "dark"
                ? "light"
                : "dark"
        localStorage.setItem(storageKey, next)
        return next
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [storageKey])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
