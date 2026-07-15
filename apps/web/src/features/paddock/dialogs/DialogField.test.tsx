import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DialogField, FieldGroup } from './DialogField';

describe('DialogField validation wiring', () => {
  it('passes id + describedby onto the child control and links the label', () => {
    render(
      <DialogField label="Name" htmlFor="name" hint="Shown in the fleet">
        <input />
      </DialogField>,
    );
    const control = screen.getByRole('textbox');
    expect(control).toHaveAttribute('id', 'name');
    expect(screen.getByText('Name')).toHaveAttribute('for', 'name');
    expect(control.getAttribute('aria-describedby')).toContain('name-hint');
    expect(control).not.toHaveAttribute('aria-invalid');
  });

  it('propagates the error state to the control and announces it via role=alert', () => {
    render(
      <DialogField label="Name" htmlFor="name" error="Name is required">
        <input />
      </DialogField>,
    );
    const control = screen.getByRole('textbox');
    const alert = screen.getByRole('alert');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(alert).toHaveTextContent('Name is required');
    expect(control.getAttribute('aria-describedby')).toContain('name-error');
  });

  it('exposes a required affordance and aria-required on the control', () => {
    render(
      <DialogField label="Name" htmlFor="name" required>
        <input />
      </DialogField>,
    );
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-required', 'true');
    // The asterisk is aria-hidden decoration alongside the accessible label text.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('FieldGroup', () => {
  it('exposes a labelled group for a set of controls', () => {
    render(
      <FieldGroup label="Authority" error="Pick one">
        <label>
          <input type="radio" name="a" /> Callback
        </label>
        <label>
          <input type="radio" name="a" /> Autonomous
        </label>
      </FieldGroup>,
    );
    const group = screen.getByRole('group', { name: /Authority/ });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick one');
  });
});
