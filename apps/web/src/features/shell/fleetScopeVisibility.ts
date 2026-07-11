/** Fleet scope is meaningful only when the main surface is not pinned to an entity. */
export function shouldShowFleetScope(selection: {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  nodeInfoNodeId: string | null;
}): boolean {
  return (
    selection.selectedSessionId === null &&
    selection.selectedProjectId === null &&
    selection.nodeInfoNodeId === null
  );
}
