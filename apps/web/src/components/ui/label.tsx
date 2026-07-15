import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../lib/utils';

/** Label — small, slightly tracked-out caps-ish label for form fields. */
export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-xs font-medium text-flock-ink-muted peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

// ---------------------------------------------------------------------------
// Headless form-field composition. FormField owns a stable id and derives the
// description/message ids from it, so a Label, a control, and an error line stay
// wired through aria-describedby / aria-invalid without any hand-passed ids.
// Kept deliberately small: Label above is untouched; these just compose around
// it. DialogField builds its opinionated field row on top of this contract.
// ---------------------------------------------------------------------------

interface FormFieldContextValue {
  /** Control id — also the Label's htmlFor. */
  id: string;
  /** Id of the hint/description node (referenced by the control). */
  descriptionId: string;
  /** Id of the role=alert error node (referenced by the control when invalid). */
  messageId: string;
  /** Whether the field is currently in an error state. */
  invalid: boolean;
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

function useFormFieldContext(): FormFieldContextValue {
  const ctx = React.useContext(FormFieldContext);
  if (!ctx) {
    throw new Error('FormLabel/FormMessage/useFormField must be used within a <FormField>.');
  }
  return ctx;
}

/**
 * Props to spread on the field's control. `aria-describedby` always points at
 * the hint and additionally at the error line while invalid; `aria-invalid`
 * only appears when the field is in error so the Input error styles engage.
 */
export function useFormField(): {
  id: string;
  descriptionId: string;
  messageId: string;
  invalid: boolean;
  controlProps: {
    id: string;
    'aria-invalid': true | undefined;
    'aria-describedby': string;
  };
} {
  const { id, descriptionId, messageId, invalid } = useFormFieldContext();
  return {
    id,
    descriptionId,
    messageId,
    invalid,
    controlProps: {
      id,
      'aria-invalid': invalid || undefined,
      'aria-describedby': invalid ? `${descriptionId} ${messageId}` : descriptionId,
    },
  };
}

/** FormField — provides the id graph + invalid state to its Label/control/message. */
export function FormField({
  id: idProp,
  invalid = false,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  id?: string;
  invalid?: boolean;
}): JSX.Element {
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  const value = React.useMemo<FormFieldContextValue>(
    () => ({ id, descriptionId: `${id}-description`, messageId: `${id}-message`, invalid }),
    [id, invalid],
  );
  return (
    <FormFieldContext.Provider value={value}>
      <div className={cn('grid gap-1.5', className)} {...props}>
        {children}
      </div>
    </FormFieldContext.Provider>
  );
}

/** FormLabel — Label bound to the field id, tinted on error. */
export const FormLabel = React.forwardRef<
  React.ElementRef<typeof Label>,
  Omit<React.ComponentPropsWithoutRef<typeof Label>, 'htmlFor'>
>(({ className, ...props }, ref) => {
  const { id, invalid } = useFormFieldContext();
  return (
    <Label
      ref={ref}
      htmlFor={id}
      data-invalid={invalid || undefined}
      className={cn(invalid && 'text-status-error', className)}
      {...props}
    />
  );
});
FormLabel.displayName = 'FormLabel';

/**
 * FormMessage — inline error line announced via role=alert. Renders nothing
 * when there is no message, so a field with no error stays visually quiet.
 */
export const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { messageId, invalid } = useFormFieldContext();
  if (!children) return null;
  return (
    <p
      ref={ref}
      id={messageId}
      role="alert"
      className={cn('text-2xs', invalid ? 'text-status-error' : 'text-flock-ink-muted', className)}
      {...props}
    >
      {children}
    </p>
  );
});
FormMessage.displayName = 'FormMessage';
