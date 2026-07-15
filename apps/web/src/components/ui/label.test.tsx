import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField, FormLabel, FormMessage, useFormField } from './label';

function Control(): JSX.Element {
  const { controlProps } = useFormField();
  return <input aria-label="control" {...controlProps} />;
}

describe('FormField composition', () => {
  it('wires the label to the control and describes it by the hint region', () => {
    render(
      <FormField>
        <FormLabel>Name</FormLabel>
        <Control />
      </FormField>,
    );
    const control = screen.getByRole('textbox');
    const label = screen.getByText('Name');
    expect(label).toHaveAttribute('for', control.id);
    expect(control).not.toHaveAttribute('aria-invalid');
    expect(control.getAttribute('aria-describedby')).toContain(`${control.id}-description`);
  });

  it('marks the control invalid and references the alert message when invalid', () => {
    render(
      <FormField invalid>
        <FormLabel>Name</FormLabel>
        <Control />
        <FormMessage>Name is required</FormMessage>
      </FormField>,
    );
    const control = screen.getByRole('textbox');
    const alert = screen.getByRole('alert');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(alert).toHaveTextContent('Name is required');
    expect(control.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('renders no message node when there is no error text', () => {
    render(
      <FormField>
        <FormLabel>Name</FormLabel>
        <Control />
        <FormMessage />
      </FormField>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
