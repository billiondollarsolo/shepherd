import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '../../../components/ui';
import { applyConfig, exportConfig, type ConfigApplySummary } from '../../../data/treeApi';

export function ConfigDialog(): JSX.Element {
  const qc = useQueryClient();
  const [yaml, setYaml] = useState('');
  const [summary, setSummary] = useState<ConfigApplySummary | null>(null);
  const exp = useMutation({
    mutationFn: exportConfig,
    onSuccess: (r) => {
      setYaml(r.yaml);
      setSummary(null);
    },
  });
  const apply = useMutation({
    mutationFn: () => applyConfig(yaml),
    onSuccess: (s) => {
      setSummary(s);
      void qc.invalidateQueries();
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Config as code (flock.yml)</DialogTitle>
        <DialogDescription>
          Define your fleet — projects, working dirs, and agents — then apply it. Re-applying is
          idempotent: existing projects and running agents are reused.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        rows={13}
        placeholder={
          'projects:\n  - node: node-vm-1\n    name: my-app\n    path: /home/flock/my-app\n    agents:\n      - type: claude-code\n        mode: plan\n      - type: codex'
        }
        className="font-mono text-xs leading-relaxed"
      />
      {apply.isError ? (
        <p className="text-xs text-status-error">{(apply.error as Error).message}</p>
      ) : null}
      {summary ? (
        <div className="rounded-md border border-[var(--flock-border)] bg-flock-surface-2 p-2 text-2xs">
          <p className="text-flock-ink-primary">
            Created {summary.projectsCreated.length} project(s) · {summary.sessionsCreated.length}{' '}
            agent(s).
          </p>
          {summary.warnings.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-flock-ink-muted">
              {summary.warnings.slice(0, 8).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={() => exp.mutate()} disabled={exp.isPending}>
          {exp.isPending ? 'Loading…' : 'Export current'}
        </Button>
        <Button onClick={() => apply.mutate()} disabled={!yaml.trim() || apply.isPending}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </DialogFooter>
    </>
  );
}
