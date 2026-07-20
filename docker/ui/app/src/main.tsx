import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/ui/ToastContext';
import { ErrorBoundary } from './components/errors/ErrorBoundary';
import { RootErrorFallback } from './components/errors/fallbacks';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't retry on 4xx errors — they're likely permanent
      retry: (failureCount, error) => {
        if (error instanceof Error && 'status' in error) {
          const status = (error as { status: number }).status;
          if (status >= 400 && status < 500) return false;
        }
        return failureCount < 2;
      },
      staleTime: 30_000,
    },
    mutations: {
      retry: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in the document');
}

createRoot(rootElement).render(
  <StrictMode>
    {/* Root error boundary — last line of defence. Route-level boundaries
        (AppLayout / App full-screen routes) catch page crashes first so the
        chrome and any active call survive; this one only fires when a
        provider or the router itself throws, and offers reload + a
        copy-details report affordance instead of a white screen. */}
    <ErrorBoundary scope="root" fallback={(error) => <RootErrorFallback error={error} />}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
