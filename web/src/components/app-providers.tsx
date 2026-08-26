import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { InternationalizationProvider } from "@astryxdesign/core/i18n"
import { LayerProvider } from "@astryxdesign/core/Layer"
import { Theme } from "@astryxdesign/core/theme"
import zhCN from "@astryxdesign/core/locales/zh-CN.json"

import { neutralTheme } from "@/theme/neutralTheme"

export type ColorMode = "light" | "dark" | "system"

const STORAGE_KEY = "theme"
const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const MODES: ColorMode[] = ["light", "dark", "system"]

function isColorMode(value: unknown): value is ColorMode {
  return typeof value === "string" && MODES.includes(value as ColorMode)
}

function readStoredMode(): ColorMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isColorMode(stored)) return stored
  } catch {
    // Private browsing or disabled storage.
  }
  return "system"
}

interface ColorModeState {
  mode: ColorMode
  setMode: (mode: ColorMode) => void
}

const ColorModeContext = createContext<ColorModeState | undefined>(undefined)

export function useColorMode() {
  const context = useContext(ColorModeContext)
  if (!context) {
    throw new Error("useColorMode must be used within AppProviders")
  }
  return context
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']")
  )
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(readStoredMode)

  const setMode = useCallback((next: ColorMode) => {
    if (!isColorMode(next)) return
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Keep in-memory mode even if storage fails.
    }
    setModeState(next)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      if (event.key.toLowerCase() !== "d") return
      setModeState((current) => {
        const systemDark = window.matchMedia(COLOR_SCHEME_QUERY).matches
        const next: ColorMode =
          current === "dark"
            ? "light"
            : current === "light"
              ? "dark"
              : systemDark
                ? "light"
                : "dark"
        try {
          localStorage.setItem(STORAGE_KEY, next)
        } catch {
          // Ignore storage failures.
        }
        return next
      })
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode])

  return (
    <InternationalizationProvider locale="zh-CN" messages={{ "zh-CN": zhCN }}>
      <Theme theme={neutralTheme} mode={mode}>
        <LayerProvider>
          <ColorModeContext.Provider value={value}>
            {children}
          </ColorModeContext.Provider>
        </LayerProvider>
      </Theme>
    </InternationalizationProvider>
  )
}
