/**
 * AuthGate — decides what the app shows: a loading veil, the auth screen, or the
 * authenticated paddock. On mount it probes `GET /api/auth/me`; a 401 means no
 * session. It then asks `GET /api/auth/status` whether the initial admin still
 * needs creating, so a fresh instance lands on "Create first admin" and an
 * existing one lands on "Sign in" — no destructive probe, no wrong-screen 401s.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@flock/shared';
import { Sheep } from '../../components/SheepIcon';
import { authStatus, logout as apiLogout, me } from '../../routes/api';
import { AuthScreen } from './AuthScreen';

type Phase =
  | { kind: 'loading' }
  | { kind: 'unauthed'; mode: 'signin' | 'setup' }
  | { kind: 'authed'; user: User };

/** The signed-in user + actions, available to the whole paddock. */
export interface AuthValue {
  user: User;
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

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { user } = await me();
        if (alive) setPhase({ kind: 'authed', user });
        return;
      } catch {
        /* not signed in — fall through to decide setup vs signin */
      }
      let mode: 'signin' | 'setup' = 'signin';
      try {
        const { setupRequired } = await authStatus();
        mode = setupRequired ? 'setup' : 'signin';
      } catch {
        /* status unreachable — default to signin; the screen can toggle */
      }
      if (alive) setPhase({ kind: 'unauthed', mode });
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (phase.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-flock-surface-0 text-flock-accent">
        <Sheep className="size-7 animate-pulse" />
      </div>
    );
  }

  if (phase.kind === 'unauthed') {
    return (
      <AuthScreen
        initialMode={phase.mode}
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
      setPhase({ kind: 'unauthed', mode: 'signin' });
    }
  };

  const updateUser = (user: User): void => setPhase({ kind: 'authed', user });

  return (
    <AuthContext.Provider value={{ user: phase.user, logout: doLogout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
