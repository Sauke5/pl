/// <reference types="vite/client" />

interface Window {
  PLTheme?: {
    version: number;
    get(): string;
    getColorScheme(): string;
    set(id: string): void;
    subscribe(listener: () => void): (() => void) | void;
    mountMenu(button: HTMLButtonElement): () => void;
  };
}
