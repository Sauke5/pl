import { useLayoutEffect, useRef } from "react";
import { Button } from "./components/ui/button";

export type UITheme = string;
declare global {
  interface Window {
    PLTheme?: {
      get(): string;
      getColorScheme(): "dark" | "light";
      set(theme: string): void;
      subscribe(listener: (theme: string) => void): () => void;
      mountMenu(button: HTMLButtonElement): () => void;
    };
  }
}
export function setUITheme(theme: UITheme) {
  window.PLTheme?.set(theme);
}
export function ThemeToggle({ className = "" }: { className?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!button.current || !window.PLTheme) return;
    return window.PLTheme.mountMenu(button.current);
  }, []);
  return (
    <Button
      ref={button}
      className={`theme-toggle ${className}`}
      variant="ghost"
      size="icon"
      aria-label="Выбрать тему"
      title="Выбрать тему"
      disabled={!window.PLTheme}
    />
  );
}
