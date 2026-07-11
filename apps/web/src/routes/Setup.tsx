/**
 * First-run owner setup screen (US-4).
 *
 * Minimal, functional form (full UI lands in the UI phase). Submits to
 * POST /api/auth/setup; on success it invokes `onComplete` so the host can
 * route to the login screen. A 409 means an owner already exists -- we surface
 * a clear message and offer to continue to login.
 */
import { useState, type FormEvent } from 'react';
import { ApiError, setupOwner } from './api';

export interface SetupProps {
  /** Called after the owner is created (or when setup is already complete). */
  onComplete?: () => void;
}

export default function Setup({ onComplete }: SetupProps): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await setupOwner({ username, password });
      setDone(true);
      onComplete?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('An owner already exists. Continue to login.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-flock-bg text-flock-fg">
        <h1 className="text-2xl font-semibold">Owner created</h1>
        <button
          type="button"
          className="rounded bg-flock-accent px-4 py-2 text-sm font-medium"
          onClick={() => onComplete?.()}
        >
          Continue to login
        </button>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-flock-bg text-flock-fg">
      <form
        onSubmit={handleSubmit}
        className="flex w-80 flex-col gap-3"
        aria-label="First-run owner setup"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Set up Flock</h1>
        <p className="text-flock-muted text-sm">Create the installation owner account.</p>

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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
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
          {submitting ? 'Creating...' : 'Create owner'}
        </button>
      </form>
    </main>
  );
}
