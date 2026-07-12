"use client";

import * as React from "react";

export type Theme = "light" | "dark";

const ThemeContext = React.createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({
  theme: "dark",
  setTheme: () => undefined,
});

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: React.PropsWithChildren<{
  attribute?: "class";
  defaultTheme?: Theme;
  disableTransitionOnChange?: boolean;
  enableSystem?: boolean;
}>) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);

  const setTheme = React.useCallback((nextTheme: Theme) => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(nextTheme);
    document.documentElement.style.colorScheme = nextTheme;
    window.localStorage.setItem("relayapi-theme", nextTheme);
    setThemeState(nextTheme);
  }, []);

  React.useEffect(() => {
    const savedTheme = window.localStorage.getItem("relayapi-theme");
    const initialTheme = savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : defaultTheme;
    const frame = window.requestAnimationFrame(() => setTheme(initialTheme));
    return () => window.cancelAnimationFrame(frame);
  }, [defaultTheme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
