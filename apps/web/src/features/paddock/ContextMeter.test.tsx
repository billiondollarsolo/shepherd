import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextMeter, contextTone } from './ContextMeter';

describe('contextTone', () => {
  it('is calm below 70%, warm from 70%, full from 90%', () => {
    expect(contextTone(0)).toBe('calm');
    expect(contextTone(69)).toBe('calm');
    expect(contextTone(70)).toBe('warn');
    expect(contextTone(89)).toBe('warn');
    expect(contextTone(90)).toBe('full');
    expect(contextTone(100)).toBe('full');
  });
});

describe('ContextMeter', () => {
  it('renders the % and exposes the tone for styling', () => {
    render(<ContextMeter pct={92} tokens={184000} limit={200000} />);
    const el = screen.getByTestId('context-meter');
    expect(el.getAttribute('data-context-tone')).toBe('full');
    expect(el.textContent).toContain('92%');
    expect(el.getAttribute('title')).toContain('184,000');
  });
});
