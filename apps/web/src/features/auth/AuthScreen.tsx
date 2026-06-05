/**
 * AuthScreen — the polished sign-in / first-run surface.
 *
 * A calm, centered card on an atmospheric background. Auto-detects first run:
 * if creating the admin returns 409 (admin exists) we flip to sign-in. On
 * success it calls `onAuthenticated` so the gate swaps in the paddock.
 */
import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { User } from '@flock/shared';
import { Sheep } from '../../components/SheepIcon';
import { ApiError, login, me, setupAdmin } from '../../routes/api';
import { Button, Input, Label } from '../../components/ui';

type Mode = 'signin' | 'setup';

export interface AuthScreenProps {
  initialMode: Mode;
  onAuthenticated: (user: User) => void;
}

export function AuthScreen({ initialMode, onAuthenticated }: AuthScreenProps): JSX.Element {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    // On first-run setup, require the password to be confirmed so a typo can't
    // silently become the admin password (there is no recovery flow yet).
    if (mode === 'setup') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'setup') {
        try {
          await setupAdmin({ username, password });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Admin already exists — fall through to a normal sign-in.
            setMode('signin');
          } else {
            throw err;
          }
        }
      }
      await login({ username, password });
      const { user } = await me();
      onAuthenticated(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid username or password.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === 'setup';

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-flock-surface-0 px-4 text-flock-ink-primary">
      {/* Atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(48rem 28rem at 50% -8%, color-mix(in srgb, var(--flock-accent) 14%, transparent), transparent 65%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.25]"
        style={{
          backgroundImage:
            'linear-gradient(var(--flock-border) 1px, transparent 1px), linear-gradient(90deg, var(--flock-border) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(40rem 30rem at 50% 30%, black, transparent 75%)',
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-flock-accent/15 text-flock-accent shadow-sm">
            <Sheep className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Flock</h1>
            <p className="mt-0.5 text-sm text-flock-ink-muted">
              {isSetup ? 'Create the first administrator.' : 'Sign in to the paddock.'}
            </p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          aria-label={isSetup ? 'First-run admin setup' : 'Log in'}
          className="grid gap-4 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-6 shadow-overlay"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="auth-username">Username</Label>
            <Input
              id="auth-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isSetup ? 8 : undefined}
            />
            {isSetup && <p className="text-2xs text-flock-ink-muted/80">At least 8 characters.</p>}
          </div>

          {isSetup && (
            <div className="grid gap-1.5">
              <Label htmlFor="auth-confirm">Confirm password</Label>
              <Input
                id="auth-confirm"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                aria-invalid={confirm.length > 0 && confirm !== password}
              />
              {confirm.length > 0 && confirm !== password && (
                <p className="text-2xs text-status-error">Passwords do not match.</p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy && <Loader2 className="size-4 animate-spin" />}
            {isSetup ? (busy ? 'Creating…' : 'Create admin') : busy ? 'Signing in…' : 'Sign in'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirm('');
              setMode(isSetup ? 'signin' : 'setup');
            }}
            className="text-center text-2xs text-flock-ink-muted underline-offset-2 hover:text-flock-ink-primary hover:underline"
          >
            {isSetup ? 'Already set up? Sign in' : 'First run? Create the first admin'}
          </button>
        </form>

        <p className="mt-4 text-center text-2xs text-flock-ink-muted">
          A web paddock for supervising a flock of coding agents.
        </p>
      </div>
    </main>
  );
}
