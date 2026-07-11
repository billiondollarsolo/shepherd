/**
 * AuthScreen — first-run password confirmation guard.
 *
 * Regression for the lockout where a typo in the (unconfirmed) setup password
 * silently became the admin password. Setup mode must require a matching
 * confirmation BEFORE it calls the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Spy on the API client so we can assert setup is NOT called on a mismatch.
const setupAdmin = vi.fn();
const login = vi.fn();
const me = vi.fn();
vi.mock('../../routes/api', async (orig) => {
  const actual = await orig<typeof import('../../routes/api')>();
  return {
    ...actual,
    setupAdmin: (...a: unknown[]) => setupAdmin(...a),
    login: (...a: unknown[]) => login(...a),
    me: (...a: unknown[]) => me(...a),
  };
});

import { AuthScreen } from './AuthScreen';

beforeEach(() => {
  setupAdmin.mockReset();
  login.mockReset();
  me.mockReset();
});

describe('AuthScreen first-run confirmation', () => {
  it('shows a Confirm password field in setup mode', () => {
    render(<AuthScreen initialMode="setup" onAuthenticated={() => {}} />);
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
  });

  it('does NOT show Confirm password in sign-in mode', () => {
    render(<AuthScreen initialMode="signin" onAuthenticated={() => {}} />);
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
  });

  it('blocks setup and never calls the API when passwords do not match', async () => {
    render(<AuthScreen initialMode="setup" onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'password999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/do not match/i));
    expect(setupAdmin).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('blocks setup when the password is shorter than 8 chars', async () => {
    render(<AuthScreen initialMode="setup" onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/at least 8/i));
    expect(setupAdmin).not.toHaveBeenCalled();
  });
});
