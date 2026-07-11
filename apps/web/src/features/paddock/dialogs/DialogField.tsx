import type { ReactNode } from 'react';
import { Label } from '../../../components/ui';

export function DialogField({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-2xs text-flock-ink-muted">{hint}</p> : null}
    </div>
  );
}
