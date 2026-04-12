interface UploadItem {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  cancelled: boolean;
}

interface UploadOverlayProps {
  visible: boolean;
  uploads: UploadItem[];
  onDismiss: () => void;
  onCancel: (id: string) => void;
}

export function UploadOverlay({ visible, uploads, onDismiss, onCancel }: UploadOverlayProps) {
  if (!visible && uploads.length === 0) return null;

  const activeUploads = uploads.filter((u) => u.status === 'uploading' || u.status === 'pending');
  const hasActive = activeUploads.length > 0;

  return (
    <div class={`upload-panel ${uploads.length > 0 ? 'upload-panel--visible' : ''}`}>
      <div class="upload-panel__header">
        <span class="font-medium text-sm">
          {hasActive
            ? `Uploading ${activeUploads.length} file${activeUploads.length > 1 ? 's' : ''}...`
            : 'Uploads complete'}
        </span>
        {!hasActive && (
          <button class="upload-panel__close" onClick={onDismiss} aria-label="Dismiss">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      <div class="upload-panel__list">
        {uploads.map((u) => (
          <div key={u.id} class="upload-panel__item">
            <span class="upload-panel__name truncate text-sm">{u.file.name}</span>
            <div class="upload-panel__bar-wrap">
              <div
                class={`upload-panel__bar ${u.status === 'error' ? 'upload-panel__bar--error' : ''} ${u.status === 'done' ? 'upload-panel__bar--done' : ''}`}
                style={{ width: `${u.progress}%` }}
              />
            </div>
            {u.status === 'uploading' && (
              <button class="upload-panel__cancel" onClick={() => onCancel(u.id)} aria-label="Cancel upload">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            {u.status === 'done' && (
              <svg class="text-success" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20,6 9,17 4,12" />
              </svg>
            )}
            {u.status === 'error' && (
              <svg class="text-error" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface DropZoneProps {
  active: boolean;
}

export function DropZone({ active }: DropZoneProps) {
  if (!active) return null;
  return (
    <div class="drop-zone">
      <div class="drop-zone__inner">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17,8 12,3 7,8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span class="text-lg font-medium" style={{ marginTop: 'var(--space-3)' }}>
          Drop files to upload
        </span>
      </div>
    </div>
  );
}

export type { UploadItem };
