/**
 * AuthGate — decides what the app shows: a loading veil, the auth screen, or the
 * authenticated paddock. On mount it probes `GET /api/auth/me`; a 401 means no
 * session. It then asks `GET /api/auth/status` whether the installation owner still
 * needs creating, so a fresh instance lands on owner setup and an
 * existing one lands on "Sign in" — no destructive probe, no wrong-screen 401s.
 *
 * Transient API downtime (orchestrator `tsx watch` restart, vite proxy
 * ECONNREFUSED) is NOT treated as logout: we retry `/me` and only flip to the
 * sign-in screen on a real 401. That avoids "logged out" spam during dev
 * reloads while the Postgres session cookie is still valid.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { DeploymentStatus, User } from '@flock/shared';
import { Sheep } from '../../components/SheepIcon';
import { ApiError, authStatus, logout as apiLogout, me } from '../../routes/api';
import { AuthScreen } from './AuthScreen';

type Phase =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'unauthed'; mode: 'signin' | 'setup'; setupTokenRequired: boolean }
  | { kind: 'authed'; user: User };

/** The signed-in user + actions, available to the whole paddock. */
export interface AuthValue {
  user: User;
  deployment: DeploymentStatus | null;
  logout: () => Promise<void>;
  /** Replace the cached user after a profile change (e.g. display name). */
  updateUser: (user: User) => void;
}
const AuthContext = createContext<AuthValue | null>(null);

/** Access the current user + logout. Only valid inside the authed app tree. */
export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used within an authenticated AuthGate');
  return v;
}

/**
 * Like {@link useAuth} but returns null instead of throwing when no provider is
 * present (e.g. components rendered in tests/Storybook outside AuthGate). Use in
 * the always-on chrome (the sidebar) so it degrades instead of crashing.
 */
export function useAuthOptional(): AuthValue | null {
  return useContext(AuthContext);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Probe session with retries. Only a 401 means "logged out"; network/5xx keeps
 * retrying so a brief orchestrator bounce does not wipe the UI session.
 */
export async function resolveAuthSession(opts?: {
  attempts?: number;
  meFn?: typeof me;
}): Promise<{ kind: 'authed'; user: User } | { kind: 'unauthed' } | { kind: 'unreachable' }> {
  const attempts = opts?.attempts ?? 10;
  const meFn = opts?.meFn ?? me;
  let sawTransient = false;

  for (let i = 0; i < attempts; i++) {
    try {
      const { user } = await meFn();
      return { kind: 'authed', user };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        return { kind: 'unauthed' };
      }
      // 502/503/ECONNREFUSED (often a non-JSON proxy error → non-ApiError) etc.
      sawTransient = true;
      await sleep(Math.min(1_500, 200 * (i + 1)));
    }
  }
  return sawTransient ? { kind: 'unreachable' } : { kind: 'unauthed' };
}

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [deployment, setDeployment] = useState<DeploymentStatus | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const statusPromise = authStatus().catch(() => null);
      const result = await resolveAuthSession();
      const status = await statusPromise;
      if (!alive) return;
      if (status) setDeployment(status.deployment);

      if (result.kind === 'authed') {
        setPhase({ kind: 'authed', user: result.user });
        return;
      }

      if (result.kind === 'unreachable') {
        // Cookie may still be fine — do not force sign-in.
        setPhase({ kind: 'unreachable' });
        return;
      }

      const setupRequired = status?.setupRequired ?? false;
      const mode: 'signin' | 'setup' = setupRequired ? 'setup' : 'signin';
      const setupTokenRequired = setupRequired && (status?.setupTokenRequired ?? false);
      if (alive) setPhase({ kind: 'unauthed', mode, setupTokenRequired });
    })();
    return () => {
      alive = false;
    };
  }, [retryToken]);

  if (phase.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-flock-surface-0 text-flock-accent">
        <Sheep className="size-7 animate-pulse" />
      </div>
    );
  }

  if (phase.kind === 'unreachable') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-flock-surface-0 px-4 text-center text-flock-ink-primary">
        <Sheep className="size-8 text-flock-accent" />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">API is restarting</h1>
          <p className="mt-1 max-w-sm text-sm text-flock-ink-muted">
            The orchestrator was briefly unreachable (common during dev reloads). Your login cookie
            is still valid — we did not sign you out.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md bg-flock-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          onClick={() => {
            setPhase({ kind: 'loading' });
            setRetryToken((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (phase.kind === 'unauthed') {
    return (
      <AuthScreen
        initialMode={phase.mode}
        setupTokenRequired={phase.setupTokenRequired}
        transportWarning={deployment?.warning}
        onAuthenticated={(user) => setPhase({ kind: 'authed', user })}
      />
    );
  }

  // Logout: revoke the server session, then drop straight to the sign-in screen
  // (no full reload — the SPA just swaps to AuthScreen). A plain function (not
  // useMemo/useCallback) on purpose: those hooks would sit AFTER the early returns
  // above (a conditional-hook violation), and AuthGate only re-renders on an auth
  // phase change — rare, and exactly when consumers SHOULD update — so memoizing
  // the context value buys nothing.
  const doLogout = async (): Promise<void> => {
    try {
      await apiLogout();
    } finally {
      setPhase({ kind: 'unauthed', mode: 'signin', setupTokenRequired: false });
    }
  };

  const updateUser = (user: User): void => setPhase({ kind: 'authed', user });

  return (
    <AuthContext.Provider value={{ user: phase.user, deployment, logout: doLogout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
