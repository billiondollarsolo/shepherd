import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * RadioGroup — accessible `role=radiogroup` / `role=radio` control built without a
 * Radix dependency (@radix-ui/react-radio-group is not installed). Items share the
 * Switch/Checkbox checked accent + `shadow-focus` ring and expose roving-tabindex
 * Arrow-key selection per the WAI-ARIA radio pattern.
 */

interface RadioGroupContextValue {
  value: string | undefined;
  setValue: (value: string) => void;
  disabled?: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext(): RadioGroupContextValue {
  const ctx = React.useContext(RadioGroupContext);
  if (!ctx) throw new Error('RadioGroupItem must be rendered within <RadioGroup>');
  return ctx;
}

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ value: valueProp, defaultValue, onValueChange, disabled, className, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
    const value = valueProp ?? uncontrolled;
    const setValue = React.useCallback(
      (next: string) => {
        if (valueProp === undefined) setUncontrolled(next);
        onValueChange?.(next);
      },
      [valueProp, onValueChange],
    );
    return (
      <RadioGroupContext.Provider value={{ value, setValue, disabled }}>
        <div ref={ref} role="radiogroup" className={cn('grid gap-2', className)} {...props} />
      </RadioGroupContext.Provider>
    );
  },
);
RadioGroup.displayName = 'RadioGroup';

export interface RadioGroupItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'type'> {
  value: string;
}

export const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ value, className, disabled, onKeyDown, onClick, ...props }, ref) => {
    const ctx = useRadioGroupContext();
    const checked = ctx.value === value;
    const isDisabled = disabled ?? ctx.disabled;
    // No selection yet → keep the group reachable by making the roving tab-stop
    // available; once a value is picked only the checked item is tabbable.
    const tabIndex = checked ? 0 : ctx.value == null ? 0 : -1;

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
      event.preventDefault();
      const group = event.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      const items = Array.from(
        group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'),
      );
      const idx = items.indexOf(event.currentTarget);
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const next = forward
        ? (idx + 1) % items.length
        : (idx - 1 + items.length) % items.length;
      const target = items[next];
      if (target) {
        target.focus();
        target.click();
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={isDisabled}
        data-state={checked ? 'checked' : 'unchecked'}
        tabIndex={isDisabled ? -1 : tabIndex}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) ctx.setValue(value);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-strong transition-colors',
          'focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:border-flock-accent',
          className,
        )}
        {...props}
      >
        {checked && <span className="size-2 rounded-full bg-flock-accent" aria-hidden="true" />}
      </button>
    );
  },
);
RadioGroupItem.displayName = 'RadioGroupItem';
