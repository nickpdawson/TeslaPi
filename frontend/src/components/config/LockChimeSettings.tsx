import { useState, useEffect, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';
import { get, del } from '../../api/client';
import { addNotification } from '../../stores/appState';
import type { LockChimeStatus } from '../../api/types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const BASE_URL = import.meta.env.DEV ? '/api' : '/api';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LockChimeSettings() {
  const [status, setStatus] = useState<LockChimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const result = await get<LockChimeStatus>('/customization/lock-chime');
      setStatus(result);
    } catch (err) {
      setStatus({ installed: false, filename: null, size: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function uploadFile(file: File) {
    // Client-side validation
    if (file.size > MAX_FILE_SIZE) {
      addNotification('error', `File too large (${formatBytes(file.size)}). Maximum is 10 MB.`);
      return;
    }

    if (file.size < 12) {
      addNotification('error', 'File is too small to be a valid WAV file.');
      return;
    }

    // Check WAV header client-side for fast feedback
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const riff = String.fromCharCode(header[0], header[1], header[2], header[3]);
    const wave = String.fromCharCode(header[8], header[9], header[10], header[11]);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      addNotification('error', 'Invalid file format. Please upload a WAV audio file.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      const result = await new Promise<{ message: string; filename: string; size: number }>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            let msg = xhr.statusText;
            try {
              const body = JSON.parse(xhr.responseText);
              if (body.detail) msg = body.detail;
            } catch { /* ignore */ }
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed -- network error'));
        xhr.open('POST', `${BASE_URL}/customization/lock-chime`);
        xhr.send(formData);
      });

      addNotification('success', result.message);
      await loadStatus();
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function handleRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }

    setRemoving(true);
    setConfirmRemove(false);
    try {
      const result = await del<{ message: string; removed: boolean }>('/customization/lock-chime');
      addNotification('success', result.message);
      await loadStatus();
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to remove lock chime');
    } finally {
      setRemoving(false);
    }
  }

  function handleFileInput(e: JSX.TargetedEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (file) {
      uploadFile(file);
    }
    // Reset so the same file can be re-selected
    input.value = '';
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files[0];
    if (file) {
      uploadFile(file);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  return (
    <div class="settings-section">
      <p class="text-sm text-secondary" style={{ marginBottom: 'var(--space-4)' }}>
        Customize the sound your Tesla makes when locking. Upload any WAV file
        -- it will be renamed and placed on the USB drive as <code>LockChime.wav</code>.
      </p>

      {/* Current status */}
      <div style={{
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--color-surface-raised)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        minHeight: '44px',
      }}>
        {loading ? (
          <span class="text-sm text-secondary">Checking...</span>
        ) : status?.installed ? (
          <>
            <span class="text-sm">
              <strong>{status.filename}</strong>
              <span class="text-secondary"> ({formatBytes(status.size)})</span>
            </span>
            <button
              class={`btn btn--sm ${confirmRemove ? 'btn--danger' : 'btn--ghost'}`}
              onClick={handleRemove}
              disabled={removing || uploading}
            >
              {removing ? 'Removing...' : confirmRemove ? 'Confirm Remove' : 'Remove'}
            </button>
          </>
        ) : (
          <span class="text-sm text-secondary">No custom chime installed</span>
        )}
      </div>

      {/* Cancel confirm on click outside */}
      {confirmRemove && (
        <p class="text-sm text-secondary" style={{ marginBottom: 'var(--space-3)' }}>
          Click "Confirm Remove" to delete the lock chime, or upload a new file to replace it.
        </p>
      )}

      {/* Upload area */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        style={{
          border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
          textAlign: 'center',
          transition: 'border-color 0.15s, background 0.15s',
          background: dragOver ? 'var(--color-primary-glow)' : 'transparent',
          cursor: uploading ? 'wait' : 'pointer',
          position: 'relative',
        }}
        onClick={() => {
          if (!uploading) {
            document.getElementById('lock-chime-file-input')?.click();
          }
        }}
      >
        <input
          id="lock-chime-file-input"
          type="file"
          accept=".wav,audio/wav,audio/x-wav"
          style={{ display: 'none' }}
          onChange={handleFileInput}
          disabled={uploading}
        />

        {uploading ? (
          <div>
            <p class="text-sm" style={{ marginBottom: 'var(--space-2)' }}>
              Uploading... {uploadProgress}%
            </p>
            <div style={{
              width: '100%',
              height: '4px',
              background: 'var(--color-border)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${uploadProgress}%`,
                height: '100%',
                background: 'var(--color-primary)',
                transition: 'width 0.2s',
              }} />
            </div>
          </div>
        ) : (
          <div>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ width: '32px', height: '32px', opacity: 0.5, marginBottom: 'var(--space-2)' }}
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17,8 12,3 7,8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p class="text-sm text-secondary">
              Choose a WAV file or drag and drop
            </p>
            <p class="text-sm text-secondary" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}>
              Max 10 MB
            </p>
          </div>
        )}
      </div>

      {/* Warning and instructions */}
      <div style={{
        marginTop: 'var(--space-4)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--color-warning-glow)',
        border: '1px solid var(--color-warning)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-warning)',
      }}>
        The USB gadget will briefly disconnect during upload. Your Tesla may
        momentarily lose access to the drive.
      </div>

      <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-3)' }}>
        After uploading, go to your Tesla's <strong>Toybox &gt; Boombox</strong> settings
        and select the lock chime from your USB drive.
      </p>
    </div>
  );
}
