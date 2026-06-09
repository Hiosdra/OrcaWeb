import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { preloadWasm } from './lib/worker-singleton'

// Start WASM loading immediately on page load — before React even mounts.
// By the time the user navigates to the Slice tab, the engine is likely ready.
preloadWasm()

createRoot(document.getElementById('root')!).render(<App />)
