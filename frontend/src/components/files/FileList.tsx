import { useState, useRef, useEffect } from 'preact/hooks';
import type { FileEntry } from '../../api/types';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';

type SortField = 'name' | 'size' | 'modified';
type SortDir = 'asc' | 'desc';

interface FileListProps {
  entries: FileEntry[];
  currentPath: string;
  loading: boolean;
  selectedPaths: Set<string>;
  onNavigate: (path: string) => void;
  onSelect: (paths: Set<string>) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onDelete: (paths: string[]) => void;
  onDownload: (path: string) => void;
  onRename: (entry: FileEntry) => void;
}

export function FileList({
  entries,
  currentPath: _currentPath,
  loading,
  selectedPaths,
  onNavigate: _onNavigate,
  onSelect,
  onDoubleClick,
  onDelete,
  onDownload,
  onRename,
}: FileListProps) {
  void _currentPath;
  void _onNavigate;
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sorted = sortEntries(entries, sortField, sortDir);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function handleRowClick(entry: FileEntry, e: MouseEvent) {
    if (e.detail === 2) {
      // double click
      onDoubleClick(entry);
      return;
    }

    if (e.shiftKey && selectedPaths.size > 0) {
      // Range select
      const lastSelected = Array.from(selectedPaths).pop()!;
      const lastIdx = sorted.findIndex((s) => s.path === lastSelected);
      const curIdx = sorted.findIndex((s) => s.path === entry.path);
      const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
      const range = new Set(selectedPaths);
      for (let i = start; i <= end; i++) {
        range.add(sorted[i].path);
      }
      onSelect(range);
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle select
      const next = new Set(selectedPaths);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      onSelect(next);
    } else {
      onSelect(new Set([entry.path]));
    }
  }

  function handleContextMenu(entry: FileEntry, e: MouseEvent) {
    e.preventDefault();
    // Make sure item is selected
    if (!selectedPaths.has(entry.path)) {
      onSelect(new Set([entry.path]));
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }

  function handleTouchStart(entry: FileEntry, e: TouchEvent) {
    const touch = e.touches[0];
    longPressTimer.current = setTimeout(() => {
      if (!selectedPaths.has(entry.path)) {
        onSelect(new Set([entry.path]));
      }
      setCtxMenu({ x: touch.clientX, y: touch.clientY, entry });
    }, 500);
  }

  function handleTouchEnd() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (!listRef.current || !listRef.current.contains(document.activeElement)) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIdx = sorted.findIndex((s) => selectedPaths.has(s.path));
        const next = e.key === 'ArrowDown'
          ? Math.min(currentIdx + 1, sorted.length - 1)
          : Math.max(currentIdx - 1, 0);
        if (next >= 0) {
          onSelect(new Set([sorted[next].path]));
        }
      } else if (e.key === 'Enter') {
        const selected = sorted.find((s) => selectedPaths.has(s.path));
        if (selected) onDoubleClick(selected);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedPaths.size > 0) {
          onDelete(Array.from(selectedPaths));
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        onSelect(new Set(sorted.map((s) => s.path)));
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [sorted, selectedPaths, onSelect, onDoubleClick, onDelete]);

  const ctxItems: ContextMenuItem[] = ctxMenu
    ? [
        {
          label: 'Download',
          icon: <DownloadIcon />,
          action: () => onDownload(ctxMenu.entry.path),
        },
        {
          label: 'Rename',
          icon: <RenameIcon />,
          action: () => onRename(ctxMenu.entry),
        },
        { label: '', action: () => {}, divider: true },
        {
          label: 'Delete',
          icon: <DeleteIcon />,
          action: () => onDelete(Array.from(selectedPaths)),
          danger: true,
        },
      ]
    : [];

  if (loading) {
    return (
      <div class="file-list__empty">
        <div class="animate-spin" style={{ width: 24, height: 24, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-accent)', borderRadius: '50%' }} />
        <span class="text-sm text-muted" style={{ marginTop: 'var(--space-2)' }}>Loading...</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div class="file-list__empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span class="text-sm text-muted" style={{ marginTop: 'var(--space-3)' }}>This folder is empty</span>
      </div>
    );
  }

  return (
    <div class="file-list" ref={listRef} tabIndex={0}>
      <div class="file-list__header">
        <SortHeader field="name" current={sortField} dir={sortDir} onSort={handleSort} label="Name" />
        <SortHeader field="size" current={sortField} dir={sortDir} onSort={handleSort} label="Size" className="file-list__col-size" />
        <SortHeader field="modified" current={sortField} dir={sortDir} onSort={handleSort} label="Modified" className="file-list__col-modified" />
      </div>
      <div class="file-list__body">
        {sorted.map((entry) => (
          <div
            key={entry.path}
            class={`file-list__row ${selectedPaths.has(entry.path) ? 'file-list__row--selected' : ''}`}
            onClick={(e) => handleRowClick(entry, e)}
            onContextMenu={(e) => handleContextMenu(entry, e)}
            onTouchStart={(e) => handleTouchStart(entry, e)}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
          >
            <div class="file-list__col-name">
              <FileIcon entry={entry} />
              <span class="truncate">{entry.name}</span>
            </div>
            <div class="file-list__col-size text-muted text-sm">
              {entry.isDirectory ? '--' : formatSize(entry.size)}
            </div>
            <div class="file-list__col-modified text-muted text-sm">
              {formatDate(entry.modified)}
            </div>
          </div>
        ))}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}

// --- Helpers ---

function sortEntries(entries: FileEntry[], field: SortField, dir: SortDir): FileEntry[] {
  const sorted = [...entries].sort((a, b) => {
    // Directories always first
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;

    let cmp = 0;
    switch (field) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'modified':
        cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
        break;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDirectory) {
    return (
      <svg class="file-list__icon file-list__icon--folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    );
  }

  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const audioExts = ['mp3', 'm4a', 'flac', 'ogg', 'wav', 'aac', 'wma'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

  if (audioExts.includes(ext)) {
    return (
      <svg class="file-list__icon file-list__icon--audio" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    );
  }
  if (videoExts.includes(ext)) {
    return (
      <svg class="file-list__icon file-list__icon--video" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5,3 19,12 5,21" />
      </svg>
    );
  }
  if (imageExts.includes(ext)) {
    return (
      <svg class="file-list__icon file-list__icon--image" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21,15 16,10 5,21" />
      </svg>
    );
  }

  // Generic file
  return (
    <svg class="file-list__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14,2 14,8 20,8" />
    </svg>
  );
}

function SortHeader({
  field,
  current,
  dir,
  onSort,
  label,
  className = '',
}: {
  field: SortField;
  current: SortField;
  dir: SortDir;
  onSort: (f: SortField) => void;
  label: string;
  className?: string;
}) {
  const active = field === current;
  return (
    <button class={`file-list__sort ${className} ${active ? 'file-list__sort--active' : ''}`} onClick={() => onSort(field)}>
      <span>{label}</span>
      {active && (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ transform: dir === 'desc' ? 'rotate(180deg)' : undefined }}>
          <polyline points="4,10 8,6 12,10" />
        </svg>
      )}
    </button>
  );
}

// Small icon components for context menu
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7,10 12,15 17,10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3,6 5,6 21,6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}
