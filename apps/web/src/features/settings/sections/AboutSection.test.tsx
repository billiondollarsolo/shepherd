import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FLOCK_VERSION } from '../../../version';
import { AboutSection, FLOCK_REPOSITORY_URL } from './AboutSection';

describe('AboutSection', () => {
  it('shows the canonical build version and repository link', () => {
    render(<AboutSection />);

    expect(screen.getByText(`v${FLOCK_VERSION}`)).toBeVisible();
    expect(screen.getByRole('link', { name: /view shepherd on github/i })).toHaveAttribute(
      'href',
      FLOCK_REPOSITORY_URL,
    );
  });
});
