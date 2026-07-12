import { describe, expect, it } from 'vitest';
import { layoutSessionIds, ProjectPensV1Schema, type ProjectPensV1 } from '@flock/shared';
import { initialPens, layoutForSessions, reconcilePens } from './penPlacement';

const PROJECT = 'project-1';

function ids(document: ProjectPensV1): string[] {
  const first = document.pens[0];
  return first ? layoutSessionIds(first.layout.root) : [];
}

describe('Pen automatic placement policy', () => {
  it('places only the first four sessions in Pen 1', () => {
    const document = initialPens(PROJECT, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(ids(document)).toEqual(['a', 'b', 'c', 'd']);
    expect(document.pens).toHaveLength(1);
    expect(document.independentSessionIds).toEqual(['e', 'f']);
  });

  it('fills available Pen 1 slots with new sessions and makes overflow sticky', () => {
    const document: ProjectPensV1 = {
      version: 1,
      projectId: PROJECT,
      activePenId: 'pen-1',
      pens: [{ id: 'pen-1', name: 'Pen 1', layout: layoutForSessions(PROJECT, ['a', 'b']) }],
      independentSessionIds: [],
    };
    const reconciled = reconcilePens(document, ['a', 'b', 'c', 'd', 'e']);
    expect(ids(reconciled)).toEqual(['a', 'b', 'c', 'd']);
    expect(reconciled.independentSessionIds).toEqual(['e']);

    const afterVacancy = reconcilePens(reconciled, ['a', 'b', 'e']);
    expect(ids(afterVacancy)).toEqual(['a', 'b']);
    expect(afterVacancy.independentSessionIds).toEqual(['e']);
  });

  it('keeps an explicitly Independent session outside an otherwise empty Pen', () => {
    const document: ProjectPensV1 = {
      version: 1,
      projectId: PROJECT,
      activePenId: 'pen-1',
      pens: [],
      independentSessionIds: ['a'],
    };
    const reconciled = reconcilePens(document, ['a']);
    expect(reconciled.pens).toEqual([]);
    expect(reconciled.independentSessionIds).toEqual(['a']);
  });

  it('upgrades older v1 documents and prunes closed Independent sessions', () => {
    const old = ProjectPensV1Schema.parse({
      version: 1,
      projectId: PROJECT,
      activePenId: 'pen-1',
      pens: [],
    });
    expect(old.independentSessionIds).toEqual([]);
    const placed = reconcilePens(old, ['a']);
    expect(ids(placed)).toEqual(['a']);

    const closed = reconcilePens({ ...placed, independentSessionIds: ['gone'] }, ['a']);
    expect(closed.independentSessionIds).toEqual([]);
  });
});
