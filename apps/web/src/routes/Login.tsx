/**
 * Login screen (US-5).
 *
 * Minimal, functional form (full UI lands in the UI phase). Submits to
 * POST /api/auth/login; on success the orchestrator sets the httpOnly session
 * cookie and we invoke `onAuthenticated`. Bad credentials -> inline 401 message.
 */
import { useState, type FormEvent } from 'react';
import type { User } from '@flock/shared';
import { PRODUCT_NAME } from '../brand';
import { ApiError, login } from './api';

export interface LoginProps {
  /** Called with the authenticated user after a successful login. */
  onAuthenticated?: (user: User) => void;
}

export default function Login({ onAuthenticated }: LoginProps): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await login({ username, password });
      onAuthenticated?.(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid username or password.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-flock-bg text-flock-fg">
      <form onSubmit={handleSubmit} className="flex w-80 flex-col gap-3" aria-label="Log in">
        <h1 className="text-2xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>
        <p className="text-flock-muted text-sm">Sign in to the paddock.</p>

        <label className="flex flex-col gap-1 text-sm">
          <span>Username</span>
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            className="rounded border border-flock-muted bg-transparent px-2 py-1"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="rounded border border-flock-muted bg-transparent px-2 py-1"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-flock-accent px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
