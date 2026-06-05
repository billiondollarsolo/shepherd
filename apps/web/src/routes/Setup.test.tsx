import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup';

function mockFetch(impl: (url: string, init: RequestInit) => Partial<Response>) {
  return vi.fn(async (url: unknown, init: unknown) =>
    impl(String(url), (init ?? {}) as RequestInit) as Response,
  );
}

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  role: 'admin',
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

  it('renders the first-run admin form', () => {
    render(<Setup />);
    expect(screen.getByRole('heading', { name: /set up flock/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('creates the admin and offers to continue to login', async () => {
    const fetchMock = mockFetch(() => ({
      ok: true,
      status: 201,
      json: async () => ({ user }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const onComplete = vi.fn();
    render(<Setup onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(await screen.findByText(/admin created/i)).toBeInTheDocument();
  });

  it('surfaces a clear message when an admin already exists (409)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'admin_exists', message: 'closed' } }),
      })),
    );
    render(<Setup />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/admin already exists/i);
  });
});
