import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { registerServiceWorker } from './push';
import { ThemeProvider } from './theme';
import { queryClient } from './data/queryClient';
import { Toaster, TooltipProvider } from './components/ui';
import './styles/ui-fonts';
import './index.css';
import './styles/responsive.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

// US-31 — wrap the paddock in the flock-theme provider (OS auto-detect on first
// load, persisted explicit choice, live OS-follow in system mode). The theme
// toggle now lives in the sidebar footer + Settings, so it is not mounted
// globally here. TanStack Query provides the server-data cache for the tree.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <App />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// US-22 / US-36 — register the service worker for Web Push + the installable PWA
// shell. Fire-and-forget and feature-detected: unsupported browsers degrade to
// the in-tab WS status sidebar. Actual push enrollment (permission + subscribe)
// is user-initiated via `enablePush()`.
void registerServiceWorker().catch(() => {
  /* SW registration is best-effort; the paddock works without Web Push. */
});
