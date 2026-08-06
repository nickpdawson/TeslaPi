import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { Modal } from '../common/Modal';
import { get, post, put } from '../../api/client';
import type { UpdateInfo, UpdateStatus, UpdateRecord, AutoUpdateConfig } from '../../api/types';

interface SystemSettingsProps {
  path?: string;
}

// Helper: format bytes to human-readable
function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

// Helper: format ISO date string
function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function SystemSettings(_props: SystemSettingsProps) {
  // --- Existing state ---
  const [showRebootModal, setShowRebootModal] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [systemInfo, setSystemInfo] = useState<{
    hostname?: string;
    os_version?: string;
    teslausb_version?: string;
    uptime?: string;
  } | null>(null);
  const [exportingDiag, setExportingDiag] = useState(false);

  // --- Update state ---
  const [currentVersion, setCurrentVersion] = useState<string>('...');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [updateHistory, setUpdateHistory] = useState<UpdateRecord[]>([]);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [autoUpdateConfig, setAutoUpdateConfig] = useState<AutoUpdateConfig>({
    enabled: false,
    interval_hours: 24,
    last_check: null,
  });
  const [uploadDragging, setUploadDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  // --- Load initial data ---
  useEffect(() => {
    get<Record<string, string>>('/system/info')
      .then(data => setSystemInfo(data))
      .catch(() => setSystemInfo(null));

    get<{ version: string }>('/updates/current-version')
      .then(data => setCurrentVersion(data.version))
      .catch(() => setCurrentVersion('unknown'));

    get<AutoUpdateConfig>('/updates/auto-check')
      .then(data => setAutoUpdateConfig(data))
      .catch(() => {});
  }, []);

  // --- Poll update status while in progress ---
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const poll = () => {
      get<UpdateStatus>('/updates/status')
        .then(status => {
          setUpdateStatus(status);
          if (!status.in_progress) {
            stopPolling();
            // Refresh version after update
            get<{ version: string }>('/updates/current-version')
              .then(data => setCurrentVersion(data.version))
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    poll();
    pollRef.current = window.setInterval(poll, 1000);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // --- Handlers ---

  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    setUpdateResult(null);
    setUpdateInfo(null);
    try {
      const info = await get<UpdateInfo>('/updates/check');
      setUpdateInfo(info);
      // Only claim "latest version" when the check actually succeeded — an error or
      // a 404/no-releases must NOT be shown as "up to date".
      if (info.status === 'error') {
        setUpdateResult(`Could not check for updates${info.error ? `: ${info.error}` : '.'}`);
      } else if (info.status === 'no_releases') {
        setUpdateResult('No releases found — could not determine update status.');
      } else if (!info.available) {
        setUpdateResult('You are running the latest version.');
      }
    } catch (err) {
      setUpdateResult(err instanceof Error ? err.message : 'Failed to check for updates');
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleUpdateNow() {
    setUpdateResult(null);
    try {
      startPolling();
      const result = await post<{ success: boolean; message: string }>('/updates/download-and-apply');
      setUpdateResult(result.message);
      setUpdateInfo(null);
    } catch (err) {
      setUpdateResult(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function handleUpload(file: File) {
    if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
      setUpdateResult('File must be a .tar.gz or .tgz archive');
      return;
    }
    setUpdateResult(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      startPolling();
      const resp = await fetch('/api/updates/upload', { method: 'POST', body: formData });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || resp.statusText);
      }
      const result = await resp.json();
      setUpdateResult(result.message);
    } catch (err) {
      setUpdateResult(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      handleUpload(input.files[0]);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setUploadDragging(false);
    if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
      handleUpload(e.dataTransfer.files[0]);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setUploadDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setUploadDragging(false);
  }

  async function handleRollback() {
    setShowRollbackModal(false);
    setUpdateResult(null);
    try {
      startPolling();
      const result = await post<{ success: boolean; message: string }>('/updates/rollback');
      setUpdateResult(result.message);
    } catch (err) {
      setUpdateResult(err instanceof Error ? err.message : 'Rollback failed');
    }
  }

  async function handleLoadHistory() {
    setShowHistory(!showHistory);
    if (!showHistory) {
      try {
        const records = await get<UpdateRecord[]>('/updates/history');
        setUpdateHistory(records);
      } catch {
        setUpdateHistory([]);
      }
    }
  }

  async function handleAutoUpdateToggle() {
    const newConfig = { ...autoUpdateConfig, enabled: !autoUpdateConfig.enabled };
    try {
      const saved = await put<AutoUpdateConfig>('/updates/auto-check', newConfig);
      setAutoUpdateConfig(saved);
    } catch {
      // revert
    }
  }

  async function handleAutoUpdateInterval(e: Event) {
    const value = parseInt((e.target as HTMLSelectElement).value, 10);
    const newConfig = { ...autoUpdateConfig, interval_hours: value };
    try {
      const saved = await put<AutoUpdateConfig>('/updates/auto-check', newConfig);
      setAutoUpdateConfig(saved);
    } catch {
      // revert
    }
  }

  async function handleReboot() {
    setRebooting(true);
    try {
      await post('/system/reboot', { confirm: true });
      setShowRebootModal(false);
    } catch {
      // ignore, system is rebooting
    }
  }

  async function handleExportDiagnostics() {
    setExportingDiag(true);
    try {
      const result = await get<Record<string, unknown>>('/diagnostics');
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `teslapi-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // handled by toast
    } finally {
      setExportingDiag(false);
    }
  }

  // --- Derived state ---
  const isUpdating = updateStatus?.in_progress ?? false;
  const progressPct = updateStatus ? Math.round(updateStatus.progress * 100) : 0;

  // --- Render ---
  return (
    <div class="settings-section">
      {/* System info grid */}
      <div class="system-info-grid">
        <div class="system-info-item">
          <span class="system-info-label">Hostname</span>
          <span class="system-info-value">{systemInfo?.hostname ?? '...'}</span>
        </div>
        <div class="system-info-item">
          <span class="system-info-label">OS Version</span>
          <span class="system-info-value">{systemInfo?.os_version ?? '...'}</span>
        </div>
        <div class="system-info-item">
          <span class="system-info-label">TeslaPi Version</span>
          <span class="system-info-value">{currentVersion}</span>
        </div>
        <div class="system-info-item">
          <span class="system-info-label">Uptime</span>
          <span class="system-info-value">{systemInfo?.uptime ?? '...'}</span>
        </div>
      </div>

      <div class="settings-divider" />

      {/* Software Update section */}
      <div class="system-actions">
        {/* Check for updates */}
        <div class="system-action-row">
          <div style={{ flex: 1 }}>
            <h4 class="system-action-title">Software Updates</h4>
            <p class="system-action-desc">
              Check for new TeslaPi releases from GitHub.
            </p>
            {updateResult && (
              <p class="system-action-result">{updateResult}</p>
            )}
          </div>
          <button
            class="btn btn--ghost"
            onClick={handleCheckUpdate}
            disabled={checkingUpdate || isUpdating}
          >
            {checkingUpdate ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>

        {/* Update available card */}
        {updateInfo?.available && !isUpdating && (
          <div class="update-available-card">
            <div class="update-available-header">
              <div>
                <h4 class="update-available-title">
                  Update Available: v{updateInfo.latest_version}
                </h4>
                <p class="update-available-meta">
                  {updateInfo.published_at && (
                    <span>Released {formatDate(updateInfo.published_at)}</span>
                  )}
                  {updateInfo.size_bytes && (
                    <span> &middot; {formatBytes(updateInfo.size_bytes)}</span>
                  )}
                </p>
              </div>
              <button class="btn btn--primary" onClick={handleUpdateNow}>
                Update Now
              </button>
            </div>

            {updateInfo.changelog && (
              <div class="update-changelog">
                <button
                  class="update-changelog-toggle"
                  onClick={() => setShowChangelog(!showChangelog)}
                >
                  {showChangelog ? 'Hide' : 'Show'} Changelog
                </button>
                {showChangelog && (
                  <pre class="update-changelog-content">{updateInfo.changelog}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Update progress */}
        {isUpdating && updateStatus && (
          <div class="update-progress-card">
            <h4 class="update-progress-title">
              {updateStatus.stage === 'downloading' && 'Downloading update...'}
              {updateStatus.stage === 'backing_up' && 'Backing up current version...'}
              {updateStatus.stage === 'installing' && 'Installing update...'}
              {updateStatus.stage === 'restarting' && 'Restarting services...'}
              {updateStatus.stage === 'verifying' && 'Verifying...'}
              {updateStatus.stage === 'rolling_back' && 'Update failed — rolling back...'}
              {!updateStatus.stage && 'Updating...'}
            </h4>
            {updateStatus.message && (
              <p class="update-progress-message">{updateStatus.message}</p>
            )}
            <div class="update-progress-bar-track">
              <div
                class="update-progress-bar-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p class="update-progress-percent">{progressPct}%</p>
          </div>
        )}

        {/* Manual upload */}
        <div class="system-action-row">
          <div style={{ flex: 1 }}>
            <h4 class="system-action-title">Manual Update</h4>
            <p class="system-action-desc">
              Upload a TeslaPi release package (.tar.gz) to install manually.
            </p>
          </div>
          <div style={{ flexShrink: 0, marginLeft: 'var(--space-4)' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar.gz,.tgz"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <button
              class="btn btn--ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUpdating}
            >
              Upload Package
            </button>
          </div>
        </div>

        {/* Drop zone (visible area for drag and drop) */}
        <div
          class={`update-dropzone ${uploadDragging ? 'update-dropzone--active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <p class="update-dropzone-text">
            {uploadDragging ? 'Drop to upload...' : 'Or drag and drop a .tar.gz file here'}
          </p>
        </div>

        <div class="settings-divider" />

        {/* Rollback */}
        <div class="system-action-row">
          <div style={{ flex: 1 }}>
            <h4 class="system-action-title">Rollback</h4>
            <p class="system-action-desc">
              Restore the previous version from the last successful backup.
            </p>
          </div>
          <button
            class="btn btn--ghost"
            onClick={() => setShowRollbackModal(true)}
            disabled={isUpdating}
          >
            Rollback
          </button>
        </div>

        {/* Auto-update toggle */}
        <div class="system-action-row">
          <div style={{ flex: 1 }}>
            <h4 class="system-action-title">Auto-Check for Updates</h4>
            <p class="system-action-desc">
              Periodically check GitHub for new releases. You will still be prompted before installing.
            </p>
            {autoUpdateConfig.last_check && (
              <p class="system-action-desc" style={{ marginTop: 'var(--space-1)' }}>
                {autoUpdateConfig.update_available
                  ? `Update available: ${autoUpdateConfig.latest_version ?? 'new version'}`
                  : 'Up to date'}
                {' · last checked '}
                {new Date(autoUpdateConfig.last_check).toLocaleString()}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: 'var(--space-4)' }}>
            <select
              class="select-input"
              value={autoUpdateConfig.interval_hours}
              onChange={handleAutoUpdateInterval}
              disabled={!autoUpdateConfig.enabled}
              style={{ width: '100px', marginRight: 'var(--space-3)' }}
            >
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>Daily</option>
              <option value={168}>Weekly</option>
            </select>
            <label class="toggle">
              <input
                class="toggle__input"
                type="checkbox"
                checked={autoUpdateConfig.enabled}
                onChange={handleAutoUpdateToggle}
              />
              <span class={`toggle__track ${autoUpdateConfig.enabled ? 'toggle__track--on' : ''}`}>
                <span class="toggle__thumb" />
              </span>
            </label>
          </div>
        </div>

        {/* Update history */}
        <div class="system-action-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h4 class="system-action-title">Update History</h4>
              <p class="system-action-desc">
                View past update and rollback operations.
              </p>
            </div>
            <button class="btn btn--ghost" onClick={handleLoadHistory}>
              {showHistory ? 'Hide' : 'Show'} History
            </button>
          </div>
          {showHistory && (
            <div class="update-history-list">
              {updateHistory.length === 0 && (
                <p class="update-history-empty">No update history yet.</p>
              )}
              {updateHistory.slice().reverse().map((record, i) => (
                <div key={i} class={`update-history-item ${record.success ? '' : 'update-history-item--failed'}`}>
                  <div class="update-history-item-header">
                    <span class="update-history-version">
                      {record.success ? '  ' : '  '}
                      {record.from_version} &rarr; {record.version}
                    </span>
                    <span class="update-history-meta">
                      {record.method} &middot; {formatDate(record.timestamp)}
                    </span>
                  </div>
                  <p class="update-history-message">{record.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="settings-divider" />

        {/* View logs */}
        <div class="system-action-row">
          <div>
            <h4 class="system-action-title">View System Logs</h4>
            <p class="system-action-desc">
              View live-streamed system, archive, and teslausb logs.
            </p>
          </div>
          <a href="/logs" class="btn btn--ghost">
            View Logs
          </a>
        </div>

        {/* Export diagnostics */}
        <div class="system-action-row">
          <div>
            <h4 class="system-action-title">Export Diagnostics</h4>
            <p class="system-action-desc">
              Download a JSON file with system info, storage status, and recent logs for troubleshooting.
            </p>
          </div>
          <button
            class="btn btn--ghost"
            onClick={handleExportDiagnostics}
            disabled={exportingDiag}
          >
            {exportingDiag ? 'Exporting...' : 'Export Diagnostics'}
          </button>
        </div>

        {/* Reboot */}
        <div class="system-action-row system-action-row--danger">
          <div>
            <h4 class="system-action-title">Reboot TeslaPi</h4>
            <p class="system-action-desc">
              Restart the Raspberry Pi. The USB gadget will disconnect from the car during reboot (typically 30-60 seconds).
            </p>
          </div>
          <button
            class="btn btn--danger"
            onClick={() => setShowRebootModal(true)}
          >
            Reboot
          </button>
        </div>
      </div>

      {/* Reboot modal */}
      <Modal
        open={showRebootModal}
        onClose={() => setShowRebootModal(false)}
        onConfirm={handleReboot}
        title="Reboot TeslaPi"
        confirmLabel={rebooting ? 'Rebooting...' : 'Reboot Now'}
        pending={rebooting}
        danger
      >
        <p>
          Are you sure you want to reboot? The USB drives will disconnect from the car
          and dashcam recording will pause until the reboot completes (typically 30-60 seconds).
        </p>
      </Modal>

      {/* Rollback modal */}
      <Modal
        open={showRollbackModal}
        onClose={() => setShowRollbackModal(false)}
        onConfirm={handleRollback}
        title="Rollback to Previous Version"
        confirmLabel="Rollback Now"
        danger
      >
        <p>
          This will restore the previously backed-up version of TeslaPi.
          The current version will be replaced and services will be restarted.
          The USB gadget will temporarily disconnect during the process.
        </p>
      </Modal>
    </div>
  );
}
