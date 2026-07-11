/**
 * Structural tests: shipped production modules import the layout and preset
 * clients (prevents “test-only” dead wiring regressions).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const webSrc = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(webSrc, rel), 'utf8');
}

describe('production wiring (herdr-aligned shell)', () => {
  it('SessionPane mounts StageLayout (not only GridView)', () => {
    const src = read('features/paddock/SessionPane.tsx');
    expect(src).toMatch(/StageLayout/);
    expect(src).toMatch(/from ['"].*StageLayout['"]/);
  });

  it('SessionPane All agents control unfocuses to project multi-agent stage', () => {
    const src = read('features/paddock/SessionPane.tsx');
    expect(src).toMatch(/All agents/);
    expect(src).toMatch(/selectProject\(session\.projectId\)/);
    expect(src).toMatch(/all-agents-btn/);
  });

  it('StageLayout uses projectLayoutApi + ProjectLayoutView + prune/reconcile', () => {
    const src = read('features/shell/StageLayout.tsx');
    expect(src).toMatch(/fetchProjectLayout/);
    expect(src).toMatch(/putProjectPens/);
    expect(src).toMatch(/ProjectLayoutView/);
    expect(src).toMatch(/reconcileProjectLayout|afterTerminateLayout/);
    expect(src).toMatch(/applySelectionZoom/);
    expect(src).toMatch(/onArrangeMode|rearrangeProjectLayout/);
  });

  it('ProjectLayoutView exposes arrange row/col/2x2 controls', () => {
    const src = read('features/shell/ProjectLayoutView.tsx');
    expect(src).toMatch(/arrange-row/);
    expect(src).toMatch(/arrange-col/);
    expect(src).toMatch(/arrange-grid2x2/);
    expect(src).toMatch(/onArrangeMode/);
  });

  it('StageLayout does not use GridView as loading fallback for same sessions', () => {
    const src = read('features/shell/StageLayout.tsx');
    expect(src).not.toMatch(/return\s*<GridView/);
    expect(src).toMatch(/Preparing project Pens/);
    expect(src).toMatch(/effectiveStageProjectId/);
  });

  it('SessionPane hides RightRail until tools chrome', () => {
    const src = read('features/paddock/SessionPane.tsx');
    expect(src).not.toMatch(/<RightRail/);
    expect(src).toMatch(/toolsOpen|stage-tools-toggle|chrome === 'tools'/);
  });

  it('Phone production path mounts the live terminal transport', () => {
    const src = read('features/responsive/PhoneView.tsx');
    expect(src).toMatch(/<GhosttyMobileTerminal/);
    expect(src).toMatch(/registerInput/);
    expect(src).not.toMatch(/from ['"].*terminal\/Terminal['"]/);
    expect(src).not.toMatch(/phone-composer|phone-stage-input/);
  });

  it('FleetView uses the persisted node order', () => {
    const src = read('features/overview/FleetView.tsx');
    expect(src).toMatch(/orderNodes/);
  });

  it('workspace probes skip disconnected nodes', () => {
    const sidebar = read('features/paddock/Sidebar.tsx');
    const fleet = read('features/overview/FleetView.tsx');
    expect(sidebar).toMatch(/useStack\(project\.nodeId, project\.workingDir, nodeConnected\)/);
    expect(fleet).toMatch(/connectionStatus === 'connected'/);
  });

  it('AddSessionDialog loads launcher presets', () => {
    const src = read('features/paddock/PaddockDialogs.tsx');
    expect(src).toMatch(/fetchLauncherPresets/);
    expect(src).toMatch(/launcher-presets|launcher-preset-/);
  });

  it('FleetView drills into nodes and NodePage opens project-scoped agents', () => {
    const fleet = read('features/overview/FleetView.tsx');
    const node = read('features/paddock/NodePage.tsx');
    expect(fleet).toMatch(/openNodeInfo\(node\.id\)/);
    expect(node).toMatch(/openAgent\(session\.id,\s*project\.id\)/);
    expect(node).toMatch(/openProjectGit\(project\.id\)/);
  });
});
