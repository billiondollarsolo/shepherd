/**
 * Agents switcher grammar: pin-first, sort, filter, group (Phase 2).
 */
import type { Status } from './status.js';
import { STATUS_POLICY } from './status.js';
import { isActiveDisplayStatus } from './display-status.js';

export type AgentSortKey =
  | 'attention'
  | 'status'
  | 'lastStatusChange'
  | 'project'
  | 'node';

export type AgentGroupKey = 'none' | 'node' | 'project' | 'nodeProject';

export interface AgentListItem {
  id: string;
  nodeId: string;
  projectId: string;
  nodeName?: string;
  projectName?: string;
  pinned: boolean;
  status: Status;
  /** ms epoch of last status transition; 0 if unknown. */
  lastStatusTransitionAt: number;
  label?: string;
}

export interface AgentListOptions {
  sort: AgentSortKey;
  pinnedOnly?: boolean;
  activeOnly?: boolean;
  group?: AgentGroupKey;
}

function cmpAttention(a: AgentListItem, b: AgentListItem): number {
  const ra = STATUS_POLICY[a.status].attentionRank;
  const rb = STATUS_POLICY[b.status].attentionRank;
  if (ra !== rb) return ra - rb;
  return b.lastStatusTransitionAt - a.lastStatusTransitionAt;
}

function cmpStatus(a: AgentListItem, b: AgentListItem): number {
  return a.status.localeCompare(b.status) || cmpAttention(a, b);
}

function cmpLast(a: AgentListItem, b: AgentListItem): number {
  return b.lastStatusTransitionAt - a.lastStatusTransitionAt || cmpAttention(a, b);
}

function cmpProject(a: AgentListItem, b: AgentListItem): number {
  const pa = a.projectName ?? a.projectId;
  const pb = b.projectName ?? b.projectId;
  return pa.localeCompare(pb) || cmpAttention(a, b);
}

function cmpNode(a: AgentListItem, b: AgentListItem): number {
  const na = a.nodeName ?? a.nodeId;
  const nb = b.nodeName ?? b.nodeId;
  return na.localeCompare(nb) || cmpAttention(a, b);
}

const SORTERS: Record<AgentSortKey, (a: AgentListItem, b: AgentListItem) => number> = {
  attention: cmpAttention,
  status: cmpStatus,
  lastStatusChange: cmpLast,
  project: cmpProject,
  node: cmpNode,
};

/**
 * Filter + pin-first sort for the Agents lens.
 * Pinned items always float above unpinned within the chosen sort.
 */
export function orderAgents(
  items: readonly AgentListItem[],
  opts: AgentListOptions,
): AgentListItem[] {
  let list = [...items];
  if (opts.pinnedOnly) list = list.filter((i) => i.pinned);
  if (opts.activeOnly) list = list.filter((i) => isActiveDisplayStatus(i.status));
  const sort = SORTERS[opts.sort];
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return sort(a, b);
  });
  return list;
}

export interface AgentGroup {
  key: string;
  label: string;
  items: AgentListItem[];
}

/** Group an already-ordered list (does not re-sort within groups beyond pin-first order). */
export function groupAgents(
  items: readonly AgentListItem[],
  group: AgentGroupKey,
): AgentGroup[] {
  if (group === 'none') {
    return [{ key: 'all', label: 'All', items: [...items] }];
  }
  const map = new Map<string, AgentListItem[]>();
  for (const item of items) {
    let key: string;
    let label: string;
    if (group === 'node') {
      key = item.nodeId;
      label = item.nodeName ?? item.nodeId;
    } else if (group === 'project') {
      key = item.projectId;
      label = item.projectName ?? item.projectId;
    } else {
      key = `${item.nodeId}::${item.projectId}`;
      label = `${item.nodeName ?? item.nodeId} · ${item.projectName ?? item.projectId}`;
    }
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
    // stash label on first
    (arr as AgentListItem[] & { _label?: string })._label = label;
  }
  return [...map.entries()].map(([key, groupItems]) => ({
    key,
    label: (groupItems as AgentListItem[] & { _label?: string })._label ?? key,
    items: groupItems,
  }));
}
