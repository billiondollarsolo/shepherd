import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GitStatusResponse } from '@flock/shared';
import { GitBadge, changedCount } from './GitBadge';

const git = (over: Partial<GitStatusResponse>): GitStatusResponse =>
  ({ branch: 'main', ahead: 0, behind: 0, files: [], ...over }) as GitStatusResponse;

describe('changedCount', () => {
  it('counts files, 0 for null/clean', () => {
    expect(changedCount(null)).toBe(0);
    expect(changedCount(undefined)).toBe(0);
    expect(changedCount(git({ files: [] }))).toBe(0);
    expect(changedCount(git({ files: [{}, {}] as GitStatusResponse['files'] }))).toBe(2);
  });
});

describe('GitBadge', () => {
  it('renders nothing for a clean / missing tree', () => {
    const { container } = render(<GitBadge git={git({ files: [] })} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<GitBadge git={null} />);
    expect(c2.firstChild).toBeNull();
  });

  it('shows the changed-file count when there are changes', () => {
    render(
      <GitBadge git={git({ branch: 'feat', files: [{}, {}, {}] as GitStatusResponse['files'] })} />,
    );
    expect(screen.getByText('3')).toBeTruthy();
  });
});
