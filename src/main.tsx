import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { preloadWasm } from './lib/worker-singleton'

// Start WASM loading immediately on page load — before React even mounts.
// By the time the user navigates to the Slice tab, the engine is likely ready.
preloadWasm()

const rootEl = document.getElementById('root')
// index.html always provides it; if a future template change ever drops the
// element, fail loudly here rather than with a null-deref inside React.
if (!rootEl) throw new Error('Root element #root not found in index.html')

createRoot(rootEl).render(<App />)
