/**
 * TopBar — brand, host chips, lens tabs, account controls.
 */
import { LogOut, Settings, User } from 'lucide-react';
import { FlockMark } from '../../components/SheepIcon';
import { ThemeToggle } from '../../theme';
import { usePaddock } from '../../store/paddock';
import { useAuthOptional } from '../auth/AuthGate';
import { AttentionInbox } from './AttentionInbox';
import { ActivityFeed } from './ActivityFeed';
import { HostChips } from '../shell/HostChips';
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

function LensTabs(): JSX.Element {
  const lens = usePaddock((s) => s.lens);
  const openMission = usePaddock((s) => s.openMission);
  const setLens = usePaddock((s) => s.setLens);
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--flock-border)] bg-flock-surface-2 p-0.5" data-testid="lens-tabs">
      <button
        type="button"
        data-active={lens === 'mission' ? '1' : '0'}
        onClick={() => openMission()}
        className={`rounded-md px-2.5 py-1 text-2xs font-medium ${
          lens === 'mission'
            ? 'bg-flock-surface-1 text-flock-ink-primary shadow-sm'
            : 'text-flock-ink-muted hover:text-flock-ink-primary'
        }`}
      >
        Mission Control
      </button>
      <button
        type="button"
        data-active={lens === 'agents' ? '1' : '0'}
        onClick={() => setLens('agents')}
        className={`rounded-md px-2.5 py-1 text-2xs font-medium ${
          lens === 'agents'
            ? 'bg-flock-surface-1 text-flock-ink-primary shadow-sm'
            : 'text-flock-ink-muted hover:text-flock-ink-primary'
        }`}
      >
        Agents
      </button>
    </div>
  );
}

export function TopBar(): JSX.Element {
  const openMission = usePaddock((s) => s.openMission);
  const openSettings = usePaddock((s) => s.openSettings);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-3">
      <button
        type="button"
        onClick={() => openMission()}
        className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-flock-surface-2"
        aria-label="Flock home"
      >
        <FlockMark className="size-6" />
        <span className="text-sm font-semibold tracking-tight text-flock-ink-primary">Flock</span>
      </button>

      <LensTabs />
      <div className="min-w-0 flex-1 overflow-x-auto">
        <HostChips />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ActivityFeed />
        <AttentionInbox />
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <SimpleTooltip label="Toggle theme">
          <ThemeToggle />
        </SimpleTooltip>
        <SimpleTooltip label="Settings">
          <Button size="icon-sm" variant="ghost" aria-label="Settings" onClick={() => openSettings()}>
            <Settings className="size-4" />
          </Button>
        </SimpleTooltip>
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <AccountMenu />
      </div>
    </header>
  );
}
