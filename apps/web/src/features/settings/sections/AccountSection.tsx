import { useState, type FormEvent } from 'react';
import { LogOut } from 'lucide-react';
import { Button, Input, Label, toast } from '../../../components/ui';
import { ApiError } from '../../../routes/api';
import { changePassword } from '../../../routes/api';
import { useAuth } from '../../auth/AuthGate';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';

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
        <SettingRow title="Signed in as" desc={`Role: ${user.role}`}>
          <span className="text-sm text-flock-ink-primary">{user.username}</span>
        </SettingRow>
        <ChangePasswordForm />
        <SettingRow title="Sign out" desc="End this browser session and return to the login screen.">
          <Button size="sm" variant="outline" onClick={() => void logout()}>
            <LogOut /> Sign out
          </Button>
        </SettingRow>
      </SettingCard>
    </div>
  );
}
