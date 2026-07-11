import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: unknown, init: unknown) =>
    impl(String(url), (init ?? {}) as RequestInit),
  );
}

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: null,
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

describe('Setup screen (US-4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the first-run owner form', () => {
    render(<Setup />);
    expect(screen.getByRole('heading', { name: /set up flock/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('creates the owner and offers to continue to login', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ user }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const onComplete = vi.fn();
    render(<Setup onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(await screen.findByText(/owner created/i)).toBeInTheDocument();
  });

  it('surfaces a clear message when an owner already exists (409)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => jsonResponse({ error: { code: 'owner_exists', message: 'closed' } }, 409)),
    );
    render(<Setup />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/owner already exists/i);
  });
});
