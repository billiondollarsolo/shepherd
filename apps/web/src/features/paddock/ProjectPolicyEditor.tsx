import { useEffect, useState } from 'react';

import {
  AgentAuthorityEnum,
  DEFAULT_PROJECT_AGENT_POLICY,
  authorityAllows,
  type AgentAuthority,
  type Project,
  type ProjectAgentPolicy,
} from '@flock/shared';

import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui';
import { useUpdateProjectAgentPolicy } from '../../data/queries';

const AUTHORITY_NAME: Record<AgentAuthority, string> = {
  callback_only: 'Independent',
  observe: 'Observe',
  collaborate: 'Collaborate',
  delegate: 'Delegate',
  manage: 'Manage',
};

type NumericPolicyKey =
  | 'maxConcurrentAgents'
  | 'spawnRateLimitPerMinute'
  | 'maxSendBytes'
  | 'maxReadMessages';

export function ProjectPolicyEditor({ project }: { project: Project }): JSX.Element {
  const update = useUpdateProjectAgentPolicy();
  const serverPolicy = project.agentPolicy ?? DEFAULT_PROJECT_AGENT_POLICY;
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<ProjectAgentPolicy>(serverPolicy);
  const [confirmedDestructiveDefault, setConfirmedDestructiveDefault] = useState(false);
  useEffect(() => {
    setPolicy(serverPolicy);
    setConfirmedDestructiveDefault(false);
  }, [serverPolicy]);

  const numberField = (key: NumericPolicyKey, label: string, min = 1) => (
    <label className="grid grid-cols-[1fr_7rem] items-center gap-2 text-xs text-flock-ink-muted">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        value={policy[key]}
        onChange={(event) =>
          setPolicy((current) => ({ ...current, [key]: Number(event.target.value) }))
        }
        className="h-8 text-right"
      />
    </label>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md border border-[var(--flock-border)] px-2 py-1 text-2xs text-flock-ink-muted hover:text-flock-ink-primary"
        >
          Default {AUTHORITY_NAME[serverPolicy.defaultAuthority]} · max{' '}
          {AUTHORITY_NAME[serverPolicy.maxAuthority]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-semibold">Agent orchestration policy</p>
          <p className="text-2xs text-flock-ink-muted">
            Server-enforced authority and resource bounds for this project.
          </p>
        </div>
        <label className="grid gap-1 text-xs text-flock-ink-muted">
          Maximum authority
          <Select
            value={policy.maxAuthority}
            onValueChange={(value) => {
              const maxAuthority = value as AgentAuthority;
              setPolicy((current) => ({
                ...current,
                maxAuthority,
                defaultAuthority: authorityAllows(maxAuthority, current.defaultAuthority)
                  ? current.defaultAuthority
                  : maxAuthority,
              }));
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AgentAuthorityEnum.options.map((authority) => (
                <SelectItem key={authority} value={authority}>
                  {AUTHORITY_NAME[authority]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-xs text-flock-ink-muted">
          Default authority
          <Select
            value={policy.defaultAuthority}
            onValueChange={(value) =>
              setPolicy((current) => ({ ...current, defaultAuthority: value as AgentAuthority }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AgentAuthorityEnum.options
                .filter((authority) => authorityAllows(policy.maxAuthority, authority))
                .map((authority) => (
                  <SelectItem key={authority} value={authority}>
                    {AUTHORITY_NAME[authority]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
        {numberField('maxConcurrentAgents', 'Concurrent agents')}
        {numberField('spawnRateLimitPerMinute', 'Spawns per minute')}
        {numberField('maxSendBytes', 'Message bytes', 256)}
        {numberField('maxReadMessages', 'Read messages')}
        {policy.defaultAuthority === 'manage' ? (
          <label className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 p-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmedDestructiveDefault}
              onChange={(event) => setConfirmedDestructiveDefault(event.target.checked)}
            />
            New agents will receive destructive terminate/restart authority by default.
          </label>
        ) : null}
        <Button
          size="sm"
          className="w-full"
          disabled={
            update.isPending ||
            (policy.defaultAuthority === 'manage' && !confirmedDestructiveDefault)
          }
          onClick={() =>
            void update
              .mutateAsync({ projectId: project.id, policy })
              .then(() => setOpen(false))
              .catch(() => undefined)
          }
        >
          {update.isPending ? 'Saving…' : 'Save policy'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
