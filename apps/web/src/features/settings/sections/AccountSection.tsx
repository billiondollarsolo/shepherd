import { useState, type FormEvent } from 'react';
import { LogOut } from 'lucide-react';
import { Button, Input, Label, toast } from '../../../components/ui';
import { ApiError } from '../../../routes/api';
import { changePassword, updateProfile } from '../../../routes/api';
import { useAuth } from '../../auth/AuthGate';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';

/** Two-letter avatar initials from a display name (or username fallback). */
function initialsOf(s: string): string {
  const base = (s.split('@')[0] || s).trim();
  const parts = base.split(/[.\-_+\s]+/).filter(Boolean);
  return (
    (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : base.slice(0, 2)).toUpperCase() || '?'
  );
}

function DisplayNameForm(): JSX.Element {
  const { user, updateUser } = useAuth();
  const [name, setName] = useState(user.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const preview = name.trim() || user.username;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const { user: updated } = await updateProfile({ displayName: name.trim() || null });
      updateUser(updated);
      toast.success('Name updated.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update name.');
    } finally {
      setBusy(false);
    }
  }

  const dirty = (name.trim() || null) !== (user.displayName ?? null);

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3 p-4">
      <p className="text-sm font-medium text-flock-ink-primary">Display name</p>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-flock-accent text-sm font-semibold text-white">
          {initialsOf(preview)}
        </span>
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="display-name" className="sr-only">
            Display name
          </Label>
          <Input
            id="display-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mike Johnson"
            maxLength={80}
            autoComplete="name"
          />
        </div>
      </div>
      <p className="text-2xs text-flock-ink-muted">
        Shown as your avatar initials in the top bar. Leave blank to use your username.
      </p>
      <div>
        <Button type="submit" size="sm" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </div>
    </form>
  );
}

function ChangePasswordForm(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (next.length < 8) {
      toast.error('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      toast.error('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      toast.success('Password changed.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3 p-4">
      <p className="text-sm font-medium text-flock-ink-primary">Change password</p>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-current">Current password</Label>
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-new">New password</Label>
        <Input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-confirm">Confirm new password</Label>
        <Input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={busy || !current || !next || !confirm}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}

export function AccountSection(): JSX.Element {
  const { user, logout } = useAuth();
  return (
    <div>
      <SectionHeader title="Account" description="Who you're signed in as on this device." />
      <SettingCard>
        <SettingRow title="Signed in as" desc="Installation owner">
          <span className="text-sm text-flock-ink-primary">{user.username}</span>
        </SettingRow>
        <DisplayNameForm />
        <ChangePasswordForm />
        <SettingRow
          title="Sign out"
          desc="End this browser session and return to the login screen."
        >
          <Button size="sm" variant="outline" onClick={() => void logout()}>
            <LogOut /> Sign out
          </Button>
        </SettingRow>
      </SettingCard>
    </div>
  );
}
