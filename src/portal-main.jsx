import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PortalApp from './PortalApp.jsx'

document.addEventListener('wheel', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'number' && document.activeElement === e.target) {
    e.preventDefault();
  }
}, { passive: false });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PortalApp />
  </StrictMode>,
)
