"use client";

import { Button } from "@/components/ui/button";
import { isLightColorTheme } from "@/lib/color-theme";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import {
Check,
ChevronDown,
Monitor,
Moon,
Palette,
Settings,
Sun,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import * as React from "react";

const themes = [
  {
    value: "dark",
    label: "Dark",
    icon: Moon,
    description: "Dark background with high contrast",
  },
  {
    value: "light",
    label: "Light",
    icon: Sun,
    description: "Balanced tonal surfaces and brand color",
  },
  {
    value: "legacy-light",
    label: "Legacy Light",
    icon: Sun,
    description: "Original bright neutral palette",
  },
  {
    value: "system",
    label: "System",
    icon: Monitor,
    description: "Follow your system preference",
  },
  {
    value: "midnight",
    label: "Midnight",
    icon: Moon,
    description: "Deep blue-black for OLED displays",
  },
  {
    value: "nord",
    label: "Nord",
    icon: Palette,
    description: "Arctic, cool-toned color palette",
  },
  {
    value: "tokyo",
    label: "Tokyo Night",
    icon: Palette,
    description: "Vibrant purple-blue inspired by Tokyo",
  },
  {
    value: "cyberpunk",
    label: "Cyberpunk",
    icon: Palette,
    description: "Neon pink and cyan, dystopian vibes",
  },
  {
    value: "tron",
    label: "Tron",
    icon: Palette,
    description: "Digital frontier, glowing cyan on black",
  },
  {
    value: "matrix",
    label: "Matrix",
    icon: Palette,
    description: "Green phosphor rain, digital downpour",
  },
];

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Close menu on outside click
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8">
        <Settings className="h-4 w-4" />
      </Button>
    );
  }

  const currentTheme = themes.find((t) => t.value === theme) || themes[0];
  const CurrentIcon = currentTheme.icon;

  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        className={cn(
          "gap-1.5 text-xs h-8",
          open && "bg-muted"
        )}
      >
        <CurrentIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{currentTheme.label}</span>
        <ChevronDown className={cn(
          "h-3 w-3 transition-transform",
          open && "rotate-180"
        )} />
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-card border border-border shadow-xl z-50 overflow-hidden"
          >
            <div className="p-2 border-b border-border/50">
              <p className="text-xs font-medium text-muted-foreground px-2">
                Theme Settings
              </p>
            </div>

            <div className="p-1.5 max-h-80 overflow-y-auto">
              {themes.map((t) => {
                const Icon = t.icon;
                const isSelected = theme === t.value;

                return (
                  <button
                    key={t.value}
                    onClick={() => {
                      setTheme(t.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-start gap-3 p-2.5 rounded-lg text-left transition-colors",
                      isSelected
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted"
                    )}
                  >
                    <div className={cn(
                      "p-1.5 rounded-md shrink-0",
                      isSelected ? "bg-primary/20" : "bg-muted"
                    )}>
                      <Icon className={cn(
                        "h-4 w-4",
                        isSelected ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.label}</span>
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 text-primary" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="p-2 border-t border-border/50 bg-muted/30">
              <p className="text-[10px] text-muted-foreground text-center">
                Current: {isLightColorTheme(resolvedTheme) ? "Light" : "Dark"} mode
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Simple toggle for quick switching between light and dark
export function ThemeQuickToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8">
        <Moon className="h-4 w-4" />
      </Button>
    );
  }

  const isDark = !isLightColorTheme(resolvedTheme);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      {isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}
