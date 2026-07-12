"use client";

import { MoonIcon, SunIcon } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={() => setTheme(nextTheme)}
      title={`切换到${nextTheme === "light" ? "浅色" : "深色"}模式`}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      <span className="sr-only">
        切换到{nextTheme === "light" ? "浅色" : "深色"}模式
      </span>
    </Button>
  );
}
