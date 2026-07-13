/**
 * AuthScreen — sign-in / first-run surface.
 *
 * Two-pane layout (marketing brand + credential form), inspired by modern
 * product login pages. Auto-detects first run: if creating the owner returns
 * 409 (owner exists) we flip to sign-in. On success it calls `onAuthenticated`
 * so the gate swaps in the paddock.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  GitBranch,
  LayoutGrid,
  Loader2,
  MonitorSmartphone,
  Terminal,
} from 'lucide-react';
import type { User } from '@flock/shared';
import { BuiltBy } from '../../components/BuiltBy';
import { FlockMark } from '../../components/SheepIcon';
import { PRODUCT_NAME, PRODUCT_TAGLINE_SENTENCE } from '../../brand';
import { ApiError, login, me, setupOwner } from '../../routes/api';
import { Button, Input, Label } from '../../components/ui';

type Mode = 'signin' | 'setup';

export interface AuthScreenProps {
  initialMode: Mode;
  onAuthenticated: (user: User) => void;
}

const FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <LayoutGrid className="size-4" aria-hidden />,
    title: 'Multi-agent paddock',
    body: 'Supervise a flock of coding agents side-by-side, or focus one on the full stage.',
  },
  {
    icon: <Terminal className="size-4" aria-hidden />,
    title: 'Live terminal & hooks',
    body: 'Honest working / idle status from agent hooks and live PTY, not stale guesses.',
  },
  {
    icon: <GitBranch className="size-4" aria-hidden />,
    title: 'Diffs & activity',
    body: 'See what each agent changed and what needs your attention without hopping hosts.',
  },
  {
    icon: <MonitorSmartphone className="size-4" aria-hidden />,
    title: 'Nodes & fleet',
    body: 'Connect remote nodes and keep the fleet view accurate when VMs come and go.',
  },
];

function BrandWordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <FlockMark className="size-8 shrink-0" />
      <div className="leading-tight">
        <div className="text-base font-semibold tracking-tight text-flock-ink-primary">
          {PRODUCT_NAME}
        </div>
        <div className="text-2xs text-flock-ink-muted">Agent supervision</div>
      </div>
    </div>
  );
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
    // silently become the owner password.
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
          await setupOwner({ username, password });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Owner already exists — fall through to a normal sign-in.
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
    <main
      className="relative flex min-h-[100dvh] w-full min-w-0 max-w-full overflow-x-hidden bg-flock-surface-0 text-flock-ink-primary"
      data-testid="auth-screen"
    >
      {/* ── Left: brand / product story ─────────────────────────────────── */}
      <aside className="relative hidden w-[48%] max-w-xl flex-col justify-between overflow-hidden border-r border-[var(--flock-border)] bg-flock-surface-1 px-10 py-10 lg:flex xl:w-1/2 xl:max-w-none xl:px-14">
        {/* Atmosphere */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(42rem 28rem at 20% 0%, color-mix(in srgb, var(--flock-accent) 18%, transparent), transparent 62%), radial-gradient(32rem 24rem at 90% 90%, color-mix(in srgb, var(--flock-accent) 8%, transparent), transparent 55%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage:
              'linear-gradient(var(--flock-border) 1px, transparent 1px), linear-gradient(90deg, var(--flock-border) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
            maskImage: 'radial-gradient(36rem 28rem at 30% 40%, black, transparent 78%)',
          }}
        />

        <div className="relative z-10">
          <BrandWordmark />
        </div>

        <div className="relative z-10 my-10 max-w-md">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--flock-border)] bg-flock-surface-0/60 px-2.5 py-1 text-2xs font-medium text-flock-ink-muted backdrop-blur-sm">
            <Activity className="size-3 text-flock-accent" aria-hidden />
            {PRODUCT_TAGLINE_SENTENCE}
          </p>
          <h1 className="font-display text-3xl font-semibold leading-[1.15] tracking-tight text-flock-ink-primary xl:text-4xl">
            Supervise a flock of agents
            <span className="block text-flock-accent">from one paddock.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-flock-ink-muted xl:text-[15px]">
            Launch, layout, and watch coding agents across nodes — live terminals, honest status,
            diffs, and attention when something needs you.
          </p>

          <ul className="mt-8 grid gap-3">
            {FEATURES.map((f) => (
              <li
                key={f.title}
                className="flex gap-3 rounded-lg border border-[var(--flock-border)] bg-flock-surface-0/55 px-3.5 py-3 backdrop-blur-sm"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-flock-accent/12 text-flock-accent">
                  {f.icon}
                </span>
                <span>
                  <span className="block text-sm font-medium text-flock-ink-primary">
                    {f.title}
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-flock-ink-muted">
                    {f.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 space-y-1.5">
          <p className="text-2xs text-flock-ink-muted">
            A web paddock for supervising a flock of coding agents.
          </p>
          <BuiltBy />
        </div>
      </aside>

      {/* ── Right: credentials ──────────────────────────────────────────── */}
      <section className="relative flex min-w-0 flex-1 flex-col justify-center px-4 py-8 sm:px-10 sm:py-12 lg:px-14">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 lg:hidden"
          style={{
            background:
              'radial-gradient(36rem 22rem at 50% -10%, color-mix(in srgb, var(--flock-accent) 12%, transparent), transparent 65%)',
          }}
        />

        <div className="relative mx-auto w-full min-w-0 max-w-[22rem]">
          <div className="mb-8 lg:mb-10">
            <BrandWordmark className="mb-8 lg:hidden" />
            <h2 className="text-2xl font-semibold tracking-tight text-flock-ink-primary">
              {isSetup ? 'Create the owner account' : `Sign in to ${PRODUCT_NAME}`}
            </h2>
            <p className="mt-1.5 text-sm text-flock-ink-muted">
              {isSetup
                ? 'First run — set up the installation owner for this paddock.'
                : 'Enter your credentials to open the paddock.'}
            </p>
          </div>

          <form
            onSubmit={onSubmit}
            aria-label={isSetup ? 'First-run owner setup' : 'Log in'}
            className="grid min-w-0 max-w-full gap-4"
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
                className="h-10 text-base sm:text-sm"
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
                className="h-10 text-base sm:text-sm"
              />
              {isSetup && <p className="text-2xs text-flock-ink-muted">At least 8 characters.</p>}
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
                  className="h-10 text-base sm:text-sm"
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

            <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {isSetup ? (busy ? 'Creating…' : 'Create owner') : busy ? 'Signing in…' : 'Sign in'}
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
              {isSetup ? 'Already set up? Sign in' : 'First run? Create the owner account'}
            </button>
          </form>

          <div className="mt-10 flex flex-col items-center gap-1.5 text-center">
            <p className="text-2xs leading-relaxed text-flock-ink-muted lg:hidden">
              A web paddock for supervising a flock of coding agents.
            </p>
            <BuiltBy className="text-center" />
          </div>
        </div>
      </section>
    </main>
  );
}
