/**
 * SettingsPage registry — the section list is the single source of truth for the
 * inner nav (desktop clusters + mobile Select groups). These pure-data checks
 * guard the Phase 7.4 wiring: the owner Audit section is registered and every
 * section is filed under a known cluster so it can't fall out of the grouped nav.
 */
import { describe, expect, it } from 'vitest';

import { SETTINGS_SECTIONS } from './SettingsPage';

const GROUPS = ['personal', 'workspace', 'system'] as const;

describe('SETTINGS_SECTIONS registry', () => {
  it('registers the owner Audit section (built-but-previously-unreachable)', () => {
    const audit = SETTINGS_SECTIONS.find((s) => s.id === 'audit');
    expect(audit).toBeDefined();
    expect(audit?.label).toBe('Audit');
    expect(audit?.group).toBe('system');
  });

  it('files every section under a known nav cluster', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(GROUPS).toContain(section.group);
    }
  });

  it('keeps section ids unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
