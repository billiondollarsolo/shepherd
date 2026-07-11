import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AgentType } from '@flock/shared';
import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../../../components/ui';
import { usePaddock } from '../../../store/paddock';
import { useProjects } from '../../../data/queries';
import { startRace } from '../../../data/treeApi';
import { DialogField as Field } from './DialogField';

const RACE_AGENTS: AgentType[] = ['claude-code', 'codex', 'gemini', 'grok', 'opencode'];
const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  grok: 'Grok',
  aider: 'Aider',
  'cursor-agent': 'Cursor Agent',
  amp: 'Amp',
  terminal: 'Terminal',
  dev: 'Dev server',
};

export function RaceDialog(): JSX.Element {
  const setRace = usePaddock((s) => s.setRace);
  const { data: projects = [] } = useProjects();
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [task, setTask] = useState('');
  const [picked, setPicked] = useState<Set<AgentType>>(
    () => new Set<AgentType>(['claude-code', 'codex']),
  );
  const toggle = (a: AgentType): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  const run = useMutation({
    mutationFn: () => startRace(projectId, task.trim(), [...picked]),
    onSuccess: (r) => setRace({ task: r.task, sessionIds: r.sessionIds }),
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Race a task</DialogTitle>
        <DialogDescription>
          Run the same task across several agents, then compare their changes side by side. Flock
          observes Git state but does not isolate or manage it.
        </DialogDescription>
      </DialogHeader>
      <Field label="Project" htmlFor="race-project">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="race-project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Task" htmlFor="race-task" hint="Sent to every racer as its first instruction.">
        <Textarea
          id="race-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          placeholder="e.g. Add a /healthz endpoint with a test."
        />
      </Field>
      <Field label="Agents" htmlFor="race-agents">
        <div className="flex flex-wrap gap-2">
          {RACE_AGENTS.map((a) => {
            const on = picked.has(a);
            return (
              <button
                key={a}
                type="button"
                onClick={() => toggle(a)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  on
                    ? 'border-flock-accent/40 bg-flock-accent/15 text-flock-ink-primary'
                    : 'border-[var(--flock-border)] text-flock-ink-muted hover:bg-flock-surface-2'
                }`}
              >
                {AGENT_LABELS[a]}
              </button>
            );
          })}
        </div>
      </Field>
      {run.isError ? (
        <p className="text-xs text-status-error">{(run.error as Error).message}</p>
      ) : null}
      <DialogFooter>
        <Button
          disabled={!projectId || task.trim().length === 0 || picked.size < 2 || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? 'Spawning…' : `Race ${picked.size} agents`}
        </Button>
      </DialogFooter>
    </>
  );
}
