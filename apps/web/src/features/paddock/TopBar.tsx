/**
 * TopBar — main-content scope and account controls. Brand + primary navigation
 * live in the full-height sidebar.
 */
import { LogOut, Settings, User } from 'lucide-react';
import { ThemeToggle } from '../../theme';
import { usePaddock } from '../../store/paddock';
import { useAuthOptional } from '../auth/AuthGate';
import { AttentionInbox } from './AttentionInbox';
import { ActivityFeed } from './ActivityFeed';
import { HostChips } from '../shell/HostChips';
import { shouldShowFleetScope } from '../shell/fleetScopeVisibility';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SimpleTooltip,
} from '../../components/ui';

function shortName(username: string): string {
  return (username.split('@')[0] || username).trim();
}
function initials(username: string): string {
  const base = shortName(username);
  const parts = base.split(/[.\-_+\s]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : base.slice(0, 2)).toUpperCase();
}

function AccountMenu(): JSX.Element | null {
  const auth = useAuthOptional();
  const openSettings = usePaddock((s) => s.openSettings);
  if (!auth) return null;
  const { user, logout } = auth;
  const display = user.displayName || user.username;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          title={display}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-flock-accent text-2xs font-semibold text-white ring-1 ring-flock-accent/30 transition-shadow hover:ring-2 hover:ring-flock-accent/50"
        >
          {initials(display)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate" title={user.username}>
          <span className="block truncate">{display}</span>
          {user.displayName ? (
            <span className="block truncate text-2xs font-normal text-flock-ink-muted">
              {user.username}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings('account')}>
          <User /> Account settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar(): JSX.Element {
  const openSettings = usePaddock((s) => s.openSettings);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const showFleetScope = shouldShowFleetScope({
    selectedSessionId,
    selectedProjectId,
    nodeInfoNodeId,
  });
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-3">
      <div className="min-w-0 flex-1">{showFleetScope ? <HostChips /> : null}</div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ActivityFeed />
        <AttentionInbox />
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <SimpleTooltip label="Toggle theme">
          <ThemeToggle />
        </SimpleTooltip>
        <SimpleTooltip label="Settings">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Settings"
            onClick={() => openSettings()}
          >
            <Settings className="size-4" />
          </Button>
        </SimpleTooltip>
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <AccountMenu />
      </div>
    </header>
  );
}
