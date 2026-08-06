import { useState, useEffect, useCallback } from 'preact/hooks';
import { get, put } from '../../api/client';
import { addNotification } from '../../stores/appState';
import { Toggle } from '../common/Toggle';
import { FormField } from '../common/FormField';

interface AutoSyncStatus {
  enabled: boolean;
  check_interval: number;
  running: boolean;
  last_check_at: string | null;
  last_action: string | null;
  last_action_at: string | null;
}

export function AutoSyncSettings() {
  const [status, setStatus] = useState<AutoSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [intervalValue, setIntervalValue] = useState(300);

  const load = useCallback(async () => {
    try {
      const s = await get<AutoSyncStatus>('/auto-sync/status');
      setStatus(s);
      setIntervalValue(s.check_interval);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function updateConfig(patch: { enabled?: boolean; check_interval?: number }) {
    setSaving(true);
    try {
      const s = await put<AutoSyncStatus>('/auto-sync/config', patch);
      setStatus(s);
      setIntervalValue(s.check_interval);
      addNotification('success', 'Auto-sync settings saved');
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to save auto-sync settings');
      // Reload so the UI reflects the server's real state, not the failed change.
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div class="settings-section">
        <span class="text-sm text-secondary">Loading…</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div class="settings-section">
        <span class="text-sm text-secondary">Auto-sync status is unavailable right now.</span>
      </div>
    );
  }

  const intervalUnchanged = intervalValue === status.check_interval;
  const intervalInvalid = !Number.isFinite(intervalValue) || intervalValue < 60;

  return (
    <div class="settings-section">
      <p class="text-sm text-secondary" style={{ marginBottom: 'var(--space-4)' }}>
        When enabled, TeslaPi periodically archives new dashcam clips to your network share
        while the archive server is reachable. Your choice is saved and survives a reboot.
      </p>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--space-4)',
      }}>
        <span class="text-sm">Automatic archiving</span>
        <Toggle
          checked={status.enabled}
          onChange={(v) => updateConfig({ enabled: v })}
          disabled={saving}
        />
      </div>

      <FormField
        label="Check interval (seconds)"
        helpText="How often to check for new clips to archive. Minimum 60 seconds."
        htmlFor="autosync-interval"
      >
        {/* No CSS gap — Tesla-browser-safe; use a margin between the two controls. */}
        <div style={{ display: 'flex' }}>
          <input
            id="autosync-interval"
            type="number"
            min={60}
            class="text-input"
            value={intervalValue}
            onInput={(e) => setIntervalValue(Number((e.target as HTMLInputElement).value))}
            disabled={saving}
          />
          <button
            class="btn btn--ghost btn--sm"
            style={{ marginLeft: 'var(--space-2)' }}
            disabled={saving || intervalInvalid || intervalUnchanged}
            onClick={() => updateConfig({ check_interval: intervalValue })}
          >
            Apply
          </button>
        </div>
      </FormField>

      <div class="text-secondary" style={{ marginTop: 'var(--space-4)', fontSize: 'var(--text-xs)' }}>
        <div>Loop: {status.running ? 'running' : 'stopped'}</div>
        {status.last_action && <div>Last action: {status.last_action}</div>}
      </div>
    </div>
  );
}
