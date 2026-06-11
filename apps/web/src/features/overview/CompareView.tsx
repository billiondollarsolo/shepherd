/**
 * CompareView — the compare/race overlay: the racers (same task, each in its own
 * worktree) side by side with their live status + git changes. Keep the winner and
 * the rest are terminated. Rendered as a full-screen layer when a race is active.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, FileDiff, X } from 'lucide-react';
import { statusLabel, type Session, type Status } from '@flock/shared';
import { useSessions, useGitStatus } from '../../data/queries';
import { terminateSession } from '../../data/treeApi';
import { useLiveStatuses } from '../paddock/liveData';
import { usePaddock } from '../../store/paddock';
import { ScrollArea, Button } from '../../components/ui';
import { StatusDot } from '../../components/StatusDot';

function RacerColumn({ session, raceIds }: { session: Session; raceIds: string[] }): JSX.Element {
  const live = useLiveStatuses();
  const status: Status = live.get(session.id) ?? session.status;
  const { data: git } = useGitStatus(session.id);
  const focusSession = usePaddock((s) => s.focusSession);
  const endRace = usePaddock((s) => s.endRace);
  const qc = useQueryClient();
  const pick = useMutation({
    mutationFn: async () => {
      for (const id of raceIds) if (id !== session.id) await terminateSession(id).catch(() => undefined);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      endRace();
      focusSession(session.id);
    },
  });
  const files = git?.files ?? [];
  // "Keep" TERMINATES the other racers — destructive, so require a 2nd click to
  // confirm (matches the app's confirm-before-destroy rule) rather than a dialog.
  const [confirming, setConfirming] = useState(false);
  const others = raceIds.filter((id) => id !== session.id).length;
  const onKeep = (): void => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    pick.mutate();
  };
  return (
    <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 ring-1 ring-white/[0.03]">
      <header className="flex items-center gap-2 border-b border-[var(--flock-border)] px-3 py-2">
        <StatusDot status={status} />
        <span className="font-semibold text-flock-ink-primary">{session.agentType}</span>
        <span className="ml-auto text-2xs text-flock-ink-muted">{statusLabel(status)}</span>
      </header>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-flock-ink-muted">
        <FileDiff className="size-3.5 text-flock-accent" />
        <span className="font-medium text-flock-ink-primary">{files.length}</span> file
        {files.length === 1 ? '' : 's'} changed
        {git?.branch ? <span className="ml-auto truncate font-mono text-2xs">{git.branch}</span> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-0.5 px-3 pb-2 font-mono text-2xs">
          {files.length === 0 ? (
            <li className="italic text-flock-ink-muted/60">no changes yet</li>
          ) : (
            files.slice(0, 40).map((f) => (
              <li key={f.path} className="flex items-center gap-2 truncate">
                <span className="w-3 shrink-0 text-flock-accent">{f.kind[0]?.toUpperCase()}</span>
                <span className="truncate text-flock-ink-muted">{f.path}</span>
              </li>
            ))
          )}
        </ul>
      </ScrollArea>
      <footer className="flex items-center gap-2 border-t border-[var(--flock-border)] p-2">
        <Button size="sm" variant="ghost" className="flex-1" onClick={() => focusSession(session.id)}>
          <ExternalLink className="size-3.5" /> Open
        </Button>
        <Button
          size="sm"
          className="flex-1"
          variant={confirming ? 'destructive' : 'primary'}
          disabled={pick.isPending}
          onClick={onKeep}
          title={confirming ? `Terminate the other ${others} racer${others === 1 ? '' : 's'}` : 'Keep this racer, terminate the others'}
        >
          <Check className="size-3.5" /> {confirming ? `End ${others} other${others === 1 ? '' : 's'}?` : 'Keep'}
        </Button>
      </footer>
    </div>
  );
}

export function CompareView(): JSX.Element | null {
  const race = usePaddock((s) => s.race);
  const endRace = usePaddock((s) => s.endRace);
  const { data: sessions = [] } = useSessions();
  if (!race) return null;
  const racers = race.sessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is Session => Boolean(s) && (s as Session).closedAt === null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-flock-bg/95 backdrop-blur-sm">
      <header className="flex items-center gap-3 border-b border-[var(--flock-border)] px-6 py-3">
        <FileDiff className="size-5 text-flock-accent" />
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold tracking-tight text-flock-ink-primary">Race · compare</h2>
          <p className="truncate text-xs text-flock-ink-muted">{race.task}</p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close compare" className="ml-auto" onClick={endRace}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {racers.length === 0 ? (
          <div className="flex w-full items-center justify-center text-sm text-flock-ink-muted">
            The racers have closed.
          </div>
        ) : (
          racers.map((r) => <RacerColumn key={r.id} session={r} raceIds={race.sessionIds} />)
        )}
      </div>
    </div>
  );
}
