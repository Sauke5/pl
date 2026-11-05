import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootstrapTheme } from './theme'
import './styles.css'
import './custom-theme.css'
import '@pl/ui/styles.css'

bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
