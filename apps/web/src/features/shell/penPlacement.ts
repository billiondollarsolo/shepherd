import {
  layoutArrangeMode,
  layoutSessionIds,
  type ArrangeMode,
  type ProjectLayoutV1,
  type ProjectPensV1,
} from '@flock/shared';
import { rearrangeProjectLayout, reconcileProjectLayout } from './projectLayoutState';

export const MAX_PEN_SIZE = 4;

export function layoutForSessions(
  projectId: string,
  sessionIds: readonly string[],
  mode: ArrangeMode = 'grid2x2',
  focus?: string | null,
): ProjectLayoutV1 {
  const layout = rearrangeProjectLayout(projectId, sessionIds, mode, focus);
  if (!layout) throw new Error('cannot build an empty Pen');
  return layout;
}

/** First-use policy: Pen 1 receives at most four sessions; overflow stays Independent. */
export function initialPens(projectId: string, openSessionIds: readonly string[]): ProjectPensV1 {
  const first = openSessionIds.slice(0, MAX_PEN_SIZE);
  const pens =
    first.length === 0
      ? []
      : [
          {
            id: 'pen-1',
            name: 'Pen 1',
            layout: layoutForSessions(projectId, first),
          },
        ];
  return {
    version: 1,
    projectId,
    activePenId: 'pen-1',
    pens,
    independentSessionIds: openSessionIds.slice(MAX_PEN_SIZE),
  };
}

/**
 * Reconcile durable placement with the current open-session set.
 *
 * - closed sessions disappear from Pens and the Independent set;
 * - explicitly Independent sessions are never auto-added;
 * - genuinely new sessions fill Pen 1 until its four-session cap;
 * - new overflow is recorded as Independent so a later vacancy cannot pull it in.
 */
export function reconcilePens(
  document: ProjectPensV1,
  openSessionIds: readonly string[],
): ProjectPensV1 {
  const open = new Set(openSessionIds);
  const claimed = new Set<string>();
  const pens: ProjectPensV1['pens'] = document.pens.flatMap((pen) => {
    const ids = layoutSessionIds(pen.layout.root)
      .filter((id) => open.has(id) && !claimed.has(id))
      .slice(0, MAX_PEN_SIZE);
    ids.forEach((id) => claimed.add(id));
    if (ids.length === 0) return [];
    const layout = reconcileProjectLayout(document.projectId, ids, pen.layout, null, {
      direction: layoutArrangeMode(pen.layout.root),
    });
    return layout ? [{ ...pen, layout: { ...layout, zoomedLeafId: null } }] : [];
  });

  const independent = new Set(
    document.independentSessionIds.filter((id) => open.has(id) && !claimed.has(id)),
  );
  const newcomers = openSessionIds.filter((id) => !claimed.has(id) && !independent.has(id));

  if (newcomers.length > 0) {
    const firstPen = pens[0];
    if (!firstPen) {
      const autoPlaced = newcomers.splice(0, MAX_PEN_SIZE);
      autoPlaced.forEach((id) => claimed.add(id));
      pens.push({
        id: 'pen-1',
        name: 'Pen 1',
        layout: layoutForSessions(document.projectId, autoPlaced),
      });
    } else {
      const current = layoutSessionIds(firstPen.layout.root);
      const autoPlaced = newcomers.splice(0, MAX_PEN_SIZE - current.length);
      if (autoPlaced.length > 0) {
        autoPlaced.forEach((id) => claimed.add(id));
        firstPen.layout = layoutForSessions(
          document.projectId,
          [...current, ...autoPlaced],
          layoutArrangeMode(firstPen.layout.root),
        );
      }
    }
  }
  newcomers.forEach((id) => independent.add(id));

  const activePenId = pens.some((pen) => pen.id === document.activePenId)
    ? document.activePenId
    : (pens[0]?.id ?? 'pen-1');
  return {
    ...document,
    pens,
    activePenId,
    independentSessionIds: openSessionIds.filter((id) => independent.has(id)),
  };
}
