import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import App from './App';

// App is auth-gated: on mount AuthGate probes GET /api/auth/me. With no session
// it falls back to the sign-in surface. Stub fetch to a 401 so the gate
// resolves deterministically (not a transient retry).
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }),
    ),
  );
});

describe('App', () => {
  it('renders the sign-in surface when unauthenticated', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /sign in to shepherd/i })).toBeInTheDocument(),
    );
  });
});
