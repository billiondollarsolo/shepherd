import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Tabs — accessible tablist built without a Radix dependency (@radix-ui/react-tabs
 * is not installed). Underline-active on `border-flock-accent`, `h-tab` rows.
 * Roving-tabindex keyboard nav (Arrow/Home/End) mirrors the WAI-ARIA tabs pattern.
 */

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be rendered within <Tabs>');
  return ctx;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ value: valueProp, defaultValue, onValueChange, className, children, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? '');
    const value = valueProp ?? uncontrolled;
    const baseId = React.useId();
    const setValue = React.useCallback(
      (next: string) => {
        if (valueProp === undefined) setUncontrolled(next);
        onValueChange?.(next);
      },
      [valueProp, onValueChange],
    );
    return (
      <TabsContext.Provider value={{ value, setValue, baseId }}>
        <div ref={ref} className={className} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = 'Tabs';

export const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        'flex h-tab items-stretch gap-4 border-b border-[var(--flock-border)]',
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, onKeyDown, onClick, ...props }, ref) => {
    const { value: selected, setValue, baseId } = useTabsContext();
    const active = selected === value;

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      const list = event.currentTarget.closest('[role="tablist"]');
      if (!list) return;
      const tabs = Array.from(
        list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
      );
      const idx = tabs.indexOf(event.currentTarget);
      let next = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (idx + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        next = (idx - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      const target = next >= 0 ? tabs[next] : undefined;
      if (target) {
        event.preventDefault();
        target.focus();
        target.click();
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={`${baseId}-tab-${value}`}
        aria-selected={active}
        aria-controls={`${baseId}-panel-${value}`}
        tabIndex={active ? 0 : -1}
        data-state={active ? 'active' : 'inactive'}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setValue(value);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'relative -mb-px inline-flex items-center whitespace-nowrap border-b-2 border-transparent px-1 text-sm font-medium',
          'text-flock-ink-muted transition-colors duration-fast ease-standard',
          'hover:text-flock-ink-primary focus-visible:outline-none focus-visible:shadow-focus',
          'disabled:pointer-events-none disabled:opacity-50',
          'data-[state=active]:border-flock-accent data-[state=active]:text-flock-ink-primary',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, className, ...props }, ref) => {
    const { value: selected, baseId } = useTabsContext();
    if (selected !== value) return null;
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`${baseId}-panel-${value}`}
        aria-labelledby={`${baseId}-tab-${value}`}
        tabIndex={0}
        className={cn('focus-visible:outline-none', className)}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';
