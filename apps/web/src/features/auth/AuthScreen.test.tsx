/**
 * AuthScreen — first-run password confirmation guard.
 *
 * Regression for the lockout where a typo in the (unconfirmed) setup password
 * silently became the owner password. Setup mode must require a matching
 * confirmation BEFORE it calls the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Spy on the API client so we can assert setup is NOT called on a mismatch.
const setupOwner = vi.fn();
const login = vi.fn();
const me = vi.fn();
vi.mock('../../routes/api', async (orig) => {
  const actual = await orig<typeof import('../../routes/api')>();
  return {
    ...actual,
    setupOwner: (...a: unknown[]) => setupOwner(...a),
    login: (...a: unknown[]) => login(...a),
    me: (...a: unknown[]) => me(...a),
  };
});

import { AuthScreen } from './AuthScreen';

beforeEach(() => {
  setupOwner.mockReset();
  login.mockReset();
  me.mockReset();
});

describe('AuthScreen first-run confirmation', () => {
  it('uses the current Shepherd hierarchy and capability terminology', () => {
    render(<AuthScreen initialMode="signin" onAuthenticated={() => {}} />);

    expect(
      screen.getByRole('heading', { name: /manage every coding agent from one paddock/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Multi-agent Pens')).toBeInTheDocument();
    expect(screen.getByText('Live terminals & status')).toBeInTheDocument();
    expect(screen.getByText('Nodes, projects & agents')).toBeInTheDocument();
    expect(screen.queryByText(/full stage|nodes & fleet|terminal & hooks/i)).toBeNull();
  });

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
    fireEvent.click(screen.getByRole('button', { name: /complete setup/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/do not match/i));
    expect(setupOwner).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('blocks setup when the password is shorter than 8 chars', async () => {
    render(<AuthScreen initialMode="setup" onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /complete setup/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/at least 8/i));
    expect(setupOwner).not.toHaveBeenCalled();
  });

  it('does not offer first-run setup on a configured sign-in screen', () => {
    render(<AuthScreen initialMode="signin" onAuthenticated={() => {}} />);
    expect(screen.queryByText(/first run/i)).toBeNull();
    expect(screen.queryByText(/owner account/i)).toBeNull();
  });
});
