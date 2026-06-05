import { RouterProvider } from '@tanstack/react-router';
import { router } from './app/router';

/**
 * Root of the web paddock.
 *
 * Routing is TanStack Router, but URL-only: the router owns the address bar
 * (real shareable URLs for sessions / projects / nodes / settings + back/forward)
 * while the shell renders from the zustand store, so terminals stay mounted across
 * navigations (no PTY reconnect). The route tree's root renders the actual app —
 * AuthGate (sign-in / first-run vs the authed paddock) wrapping the US-36
 * responsive surface; child routes only shape the URL. See app/router.tsx.
 */
export default function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
