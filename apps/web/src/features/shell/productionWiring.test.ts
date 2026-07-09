/**
 * Structural tests: shipped production modules import the selection / layout /
 * preset clients (prevents “test-only” dead wiring regressions).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const webSrc = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(webSrc, rel), 'utf8');
}

describe('production wiring (herdr-aligned shell)', () => {
  it('Paddock mounts FleetSelectionSync', () => {
    const src = read('app/Paddock.tsx');
    expect(src).toMatch(/FleetSelectionSync/);
    expect(src).toMatch(/from ['\"].*FleetSelectionSync['\"]/);
  });

  it('FleetSelectionSync uses runFleetSelectionTick (PUT/GET path)', () => {
    const src = read('features/shell/FleetSelectionSync.tsx');
    expect(src).toMatch(/runFleetSelectionTick/);
    const sync = read('features/shell/fleetSelectionSync.ts');
    expect(sync).toMatch(/putFleetSelection/);
    expect(sync).toMatch(/fetchFleetSelection/);
  });

  it('SessionPane mounts StageLayout (not only GridView)', () => {
    const src = read('features/paddock/SessionPane.tsx');
    expect(src).toMatch(/StageLayout/);
    expect(src).toMatch(/from ['\"].*StageLayout['\"]/);
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
    expect(src).toMatch(/putProjectLayout/);
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
    expect(src).toMatch(/stage-loading|stageRenderMode|Preparing paddock stage/);
    expect(src).toMatch(/effectiveStageProjectId/);
  });

  it('SessionPane hides RightRail until tools chrome', () => {
    const src = read('features/paddock/SessionPane.tsx');
    expect(src).not.toMatch(/<RightRail/);
    expect(src).toMatch(/toolsOpen|stage-tools-toggle|chrome === 'tools'/);
  });

  it('Phone production path wires sendPhoneInject', () => {
    const src = read('features/responsive/ResponsivePaddock.tsx');
    expect(src).toMatch(/sendPhoneInject/);
    expect(src).toMatch(/onSendInput/);
  });

  it('MissionControl filters by hostScope', () => {
    const src = read('features/overview/MissionControl.tsx');
    expect(src).toMatch(/filterSessionsByHostScope/);
    expect(src).toMatch(/hostScope/);
  });

  it('AddSessionDialog loads launcher presets', () => {
    const src = read('features/paddock/PaddockDialogs.tsx');
    expect(src).toMatch(/fetchLauncherPresets/);
    expect(src).toMatch(/launcher-presets|launcher-preset-/);
  });

  it('MissionControl openSession passes projectId', () => {
    const src = read('features/overview/MissionControl.tsx');
    expect(src).toMatch(/openAgent\(s\.id,\s*s\.projectId\)/);
  });
});
