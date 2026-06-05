import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient for the paddock. Calm defaults: don't refetch on every
 * window focus (this is a long-lived dashboard), retry once, and keep data
 * fresh for a few seconds so navigation feels instant.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 3_000,
      refetchOnWindowFocus: false,
    },
  },
});
