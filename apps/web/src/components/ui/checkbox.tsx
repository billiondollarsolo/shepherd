import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Checkbox — accessible `role=checkbox` control built without a Radix dependency
 * (@radix-ui/react-checkbox is not installed). Mirrors Switch's checked accent
 * (`data-[state=checked]:bg-flock-accent`) and the shared `shadow-focus` ring.
 */
export interface CheckboxProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'checked' | 'defaultChecked' | 'onChange' | 'type'
  > {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked: checkedProp, defaultChecked, onCheckedChange, className, onClick, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultChecked ?? false);
    const checked = checkedProp ?? uncontrolled;

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      const next = !checked;
      if (checkedProp === undefined) setUncontrolled(next);
      onCheckedChange?.(next);
    };

    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        data-state={checked ? 'checked' : 'unchecked'}
        onClick={handleClick}
        className={cn(
          'peer inline-flex size-4 shrink-0 items-center justify-center rounded-xs border border-strong transition-colors',
          'text-[var(--flock-accent-foreground)]',
          'focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:border-transparent data-[state=checked]:bg-flock-accent',
          className,
        )}
        {...props}
      >
        {checked && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
      </button>
    );
  },
);
Checkbox.displayName = 'Checkbox';
