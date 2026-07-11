import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

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

describe('Login screen (US-5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders username + password fields and a sign-in button', () => {
    render(<Login />);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('calls onAuthenticated with the user on success (credentials included)', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ user }));
    vi.stubGlobal('fetch', fetchMock);

    const onAuthenticated = vi.fn();
    render(<Login onAuthenticated={onAuthenticated} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(user));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('include');
  });

  it('shows an error on 401 bad credentials', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        jsonResponse({ error: { code: 'invalid_credentials', message: 'nope' } }, 401),
      ),
    );
    render(<Login />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid username or password/i);
  });
});
