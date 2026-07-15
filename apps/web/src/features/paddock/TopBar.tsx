/**
 * TopBar — main-content scope and account controls. Brand + primary navigation
 * live in the full-height sidebar.
 */
import { Command, LogOut, Search, Settings, User } from 'lucide-react';
import { ThemeToggle } from '../../theme';
import { usePaddock } from '../../store/paddock';
import { useAuthOptional } from '../auth/AuthGate';
import { TransportWarning } from '../auth/TransportWarning';
import { AttentionInbox } from './AttentionInbox';
import { ActivityFeed } from './ActivityFeed';
import { useShell } from '../../app/KeyboardProvider';
import { useNodes, useProjects, useSessions } from '../../data/queries';
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
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-flock-surface-3 text-2xs font-semibold text-flock-ink-primary ring-1 ring-flock-accent/40 transition-shadow hover:ring-2 hover:ring-flock-accent/60"
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
  const auth = useAuthOptional();
  const { openPalette } = useShell();
  const openSettings = usePaddock((s) => s.openSettings);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const activePenId = usePaddock((s) => s.activePenId);
  const projectView = usePaddock((s) => s.projectView);
  const penGroups = usePaddock((s) => s.penGroups);
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const contextProjectId = selectedProjectId ?? selectedSession?.projectId ?? null;
  const contextProject = projects.find((project) => project.id === contextProjectId);
  const contextNode = nodes.find((node) => node.id === nodeInfoNodeId);
  const activePen = penGroups.find((pen) => pen.id === activePenId);
  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm text-flock-ink-muted">
          <span className="truncate font-medium text-flock-ink-primary">
            {contextProject?.name ?? contextNode?.name ?? 'Paddock'}
          </span>
          {contextProject && (projectView === 'git' || projectView === 'ports') ? (
            <>
              <span aria-hidden>/</span>
              <span className="truncate">{projectView === 'git' ? 'Source Control' : 'Ports'}</span>
            </>
          ) : contextProject && activePen ? (
            <>
              <span aria-hidden>/</span>
              <span className="truncate">{activePen.name}</span>
              <span className="shrink-0 text-2xs">· {activePen.sessionIds.length} agents</span>
            </>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={openPalette}
        className="hidden h-7 w-56 shrink-0 items-center gap-1.5 rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2 text-xs text-flock-ink-muted transition-colors hover:border-[var(--flock-border-strong)] hover:bg-flock-surface-2 hover:text-flock-ink-primary md:flex"
        aria-label="Search agents, projects, nodes, and commands"
      >
        <Search className="size-3.5" />
        <span className="truncate">Search agents, projects, nodes…</span>
        <kbd className="ml-auto inline-flex items-center gap-0.5 rounded border border-[var(--flock-border)] bg-flock-surface-1 px-1.5 py-0.5 font-sans text-2xs">
          <Command className="size-2.5" />K
        </kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <TransportWarning warning={auth?.deployment?.warning} compact />
        <ActivityFeed />
        <AttentionInbox />
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <SimpleTooltip label="Toggle theme">
          <ThemeToggle className="!size-8 [&_svg]:!size-[18px]" />
        </SimpleTooltip>
        <SimpleTooltip label="Settings">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Settings"
            onClick={() => openSettings()}
          >
            <Settings className="size-[18px]" />
          </Button>
        </SimpleTooltip>
        <div className="mx-1 h-5 w-px bg-[var(--flock-border)]" />
        <AccountMenu />
      </div>
    </header>
  );
}
