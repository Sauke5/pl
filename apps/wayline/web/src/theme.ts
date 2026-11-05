// The shared controller owns theme persistence and palettes. This adapter only
// preserves a usable legacy palette when its own-origin assets are unavailable.
export function bootstrapTheme(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.PLTheme) return
  let value = 'dark'
  try { value = window.localStorage.getItem('pl-ui-theme') || 'dark' } catch { /* Storage is optional. */ }
  document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'
}

export function mountThemeMenu(button: HTMLButtonElement): () => void {
  if (window.PLTheme?.mountMenu) return window.PLTheme.mountMenu(button)
  const previous = { disabled: button.disabled, title: button.title, textContent: button.textContent }
  button.disabled = true
  button.title = 'Выбор темы временно недоступен'
  return () => Object.assign(button, previous)
}
