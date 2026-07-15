import * as React from 'react';
import type { ReactNode } from 'react';
import { Label } from '../../../components/ui';
import { cn } from '../../../lib/utils';

/** Accessible-name text + required marker shared by DialogField and FieldGroup. */
function LabelContent({ label, required }: { label: string; required?: boolean }): JSX.Element {
  return (
    <>
      {label}
      {required ? (
        <span className="ml-0.5 text-status-error" aria-hidden="true">
          *
        </span>
      ) : null}
    </>
  );
}

export function DialogField({
  label,
  htmlFor,
  children,
  hint,
  error,
  required,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
  /** When set, the field renders in an error state and announces via role=alert. */
  error?: string;
  /** Marks the field required — visual affordance + aria-required on the control. */
  required?: boolean;
}): JSX.Element {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  // Passthrough the id graph + validation state onto the single child control so
  // callers only describe intent (hint/error/required) — never wire ids by hand.
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: (children.props as { id?: string }).id ?? htmlFor,
        'aria-invalid': error ? true : (children.props as Record<string, unknown>)['aria-invalid'],
        'aria-describedby':
          cn(
            (children.props as { ['aria-describedby']?: string })['aria-describedby'],
            hintId,
            errorId,
          ) || undefined,
        'aria-required': required
          ? true
          : (children.props as Record<string, unknown>)['aria-required'],
      })
    : children;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className={cn(error && 'text-status-error')}>
        <LabelContent label={label} required={required} />
      </Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-2xs text-flock-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-2xs text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * FieldGroup — labelled wrapper for a set of related controls (radio group,
 * checkbox list, segmented toggles) that has no single control to point a
 * <label> at. Emits role=group + aria-labelledby so assistive tech announces the
 * group name, and shares DialogField's hint/error/required affordances.
 */
export function FieldGroup({
  label,
  children,
  hint,
  error,
  required,
  id,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Optional stable base id; auto-generated when omitted. */
  id?: string;
}): JSX.Element {
  const generatedId = React.useId();
  const baseId = id ?? generatedId;
  const labelId = `${baseId}-label`;
  const hintId = hint ? `${baseId}-hint` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={cn(hintId, errorId) || undefined}
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      className="grid gap-1.5"
    >
      <span
        id={labelId}
        className={cn(
          'text-xs font-medium text-flock-ink-muted',
          error && 'text-status-error',
        )}
      >
        <LabelContent label={label} required={required} />
      </span>
      {children}
      {hint ? (
        <p id={hintId} className="text-2xs text-flock-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-2xs text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
