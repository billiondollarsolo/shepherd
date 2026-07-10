/**
 * US-34 — plan extraction unit tests.
 *
 * The agent plan rides the existing TodoWrite hook callbacks; `extractPlan`
 * normalizes Claude Code's `tool_input.todos` into the shared PlanItem shape and
 * returns null for anything that isn't a plan (so the endpoint skips the event).
 */
import { describe, expect, it } from 'vitest';

import { extractPlan } from './plan.js';

const TODO_WRITE = {
  hook_event_name: 'PostToolUse',
  tool_name: 'TodoWrite',
  tool_input: {
    todos: [
      { content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser' },
      { content: 'Wire the route', status: 'in_progress', activeForm: 'Wiring the route' },
      { content: 'Add tests', status: 'pending', activeForm: 'Adding tests' },
    ],
  },
};

describe('extractPlan', () => {
  it('normalizes a Claude TodoWrite into plan items', () => {
    const plan = extractPlan(TODO_WRITE, 'claude-code');
    expect(plan).toEqual({
      items: [
        { content: 'Write the parser', status: 'completed' },
        { content: 'Wire the route', status: 'in_progress' },
        { content: 'Add tests', status: 'pending' },
      ],
    });
  });

  it('infers Claude from the payload shape when no agentType is given', () => {
    expect(extractPlan(TODO_WRITE)?.items).toHaveLength(3);
  });

  it('coerces an unknown status to pending and falls back to activeForm for content', () => {
    const plan = extractPlan(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'TodoWrite',
        tool_input: { todos: [{ status: 'weird', activeForm: 'Doing a thing' }] },
      },
      'claude-code',
    );
    expect(plan).toEqual({ items: [{ content: 'Doing a thing', status: 'pending' }] });
  });

  it('returns null for a non-TodoWrite hook event', () => {
    expect(extractPlan({ hook_event_name: 'Stop' }, 'claude-code')).toBeNull();
    expect(
      extractPlan({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 'claude-code'),
    ).toBeNull();
  });

  it('returns null for a TodoWrite with no usable items', () => {
    expect(
      extractPlan(
        { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [] } },
        'claude-code',
      ),
    ).toBeNull();
  });

  it('returns null for non-Claude agents (not yet mapped)', () => {
    expect(extractPlan(TODO_WRITE, 'codex')).toBeNull();
    expect(extractPlan(TODO_WRITE, 'terminal')).toBeNull();
  });

  it('extracts OpenCode todo.updated plan with agentType', () => {
    const plan = extractPlan(
      {
        type: 'todo.updated',
        properties: {
          todos: [
            { content: 'Ship plan', status: 'in_progress' },
            { content: 'Write tests', status: 'pending' },
          ],
        },
      },
      'opencode',
    );
    expect(plan).toEqual({
      items: [
        { content: 'Ship plan', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ],
    });
  });

  it('infers OpenCode plan from payload shape when agentType is omitted', () => {
    const plan = extractPlan({
      type: 'todo.updated',
      properties: { todos: [{ content: 'Infer me', status: 'completed' }] },
    });
    expect(plan).toEqual({ items: [{ content: 'Infer me', status: 'completed' }] });
  });
});
