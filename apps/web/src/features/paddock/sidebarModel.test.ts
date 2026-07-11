import { describe, expect, it } from 'vitest';
import { reorderNodeIds } from './sidebarModel';

describe('sidebar node ordering model', () => {
  it('uses the same move operation for pointer and keyboard controllers', () => {
    expect(reorderNodeIds(['a', 'b', 'c'], 'b', 'c')).toEqual(['a', 'c', 'b']);
    expect(reorderNodeIds(['a', 'b', 'c'], 'c', 'b')).toEqual(['a', 'c', 'b']);
  });

  it('is stable for missing ids and self-drops', () => {
    expect(reorderNodeIds(['a', 'b'], 'missing', 'a')).toEqual(['a', 'b']);
    expect(reorderNodeIds(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
});
