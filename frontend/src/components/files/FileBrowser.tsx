import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import type { FileEntry } from '../../api/types';
import { useFiles, shouldApplyListing } from '../../hooks/useFiles';
import type { Drive } from '../../hooks/useFiles';
import { FileTree } from './FileTree';
import { FileList } from './FileList';
import { AudioPlayer, isAudioFile } from './AudioPlayer';
import { UploadOverlay, DropZone } from './UploadOverlay';
import type { UploadItem } from './UploadOverlay';

const DRIVES: { id: Drive; label: string; icon: string }[] = [
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'lightshow', label: 'Light Show', icon: 'lightshow' },
  { id: 'boombox', label: 'Boombox', icon: 'boombox' },
];

interface FileBrowserProps {
  path?: string;
  matches?: Record<string, string>;
}

export function FileBrowser(_props: FileBrowserProps) {
  const [drive, setDrive] = useState<Drive>('music');
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [, setParentPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showTree, setShowTree] = useState(true);
  const [audioSrc, setAudioSrc] = useState<{ url: string; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const dragCounter = useRef(0);
  // Abort functions for in-flight uploads, keyed by upload id, so Cancel can stop
  // the actual XHR transfer (not just flip UI state).
  const uploadAborts = useRef<Map<string, () => void>>(new Map());
  // Monotonic token so a late listing response can't overwrite a newer one. Without
  // it, switching drives while a request is in flight lets the old drive's files
  // render under the new drive — and a delete would then target the wrong drive.
  const requestSeq = useRef(0);
  // The live current drive. A mutation handler (delete/rename/mkdir/upload) captures
  // the drive from its render and calls navigate() AFTER the mutation resolves — if
  // the user switched drives meanwhile, that stale navigate would issue a fresh (so
  // seq-newest) request for the OLD drive and win. The seq only orders requests; this
  // ref lets a response verify it's still for the drive on screen.
  const driveRef = useRef(drive);
  useEffect(() => {
    driveRef.current = drive;
  }, [drive]);

  const { loading, listFiles, uploadFile, createFolder, deleteItems, moveItem, getDownloadUrl } = useFiles();

  // Fetch directory listing
  const navigate = useCallback(async (path: string) => {
    setSelectedPaths(new Set());
    const seq = ++requestSeq.current;
    const reqDrive = drive;
    const data = await listFiles(drive, path);
    // Drop a stale response (see shouldApplyListing): a newer navigate superseded
    // this one, or the drive on screen changed since the request was issued.
    if (!shouldApplyListing(seq, requestSeq.current, reqDrive, driveRef.current)) return;
    if (data) {
      setCurrentPath(data.path);
      setEntries(data.entries);
      setParentPath(data.parent);
    }
  }, [drive, listFiles]);

  // Re-fetch when drive changes
  useEffect(() => {
    setCurrentPath('/');
    setEntries([]);
    setParentPath(null);
    setSelectedPaths(new Set());
    navigate('/');
  }, [drive]);

  // Initial load
  useEffect(() => {
    navigate('/');
  }, []);

  // Breadcrumb segments
  const breadcrumbs = buildBreadcrumbs(currentPath);

  function handleDoubleClick(entry: FileEntry) {
    if (entry.isDirectory) {
      navigate(entry.path);
    } else if (isAudioFile(entry.name)) {
      setAudioSrc({ url: getDownloadUrl(drive, entry.path), name: entry.name });
    } else {
      // Download
      triggerDownload(getDownloadUrl(drive, entry.path), entry.name);
    }
  }

  function handleDownload(path: string) {
    const entry = entries.find((e) => e.path === path);
    triggerDownload(getDownloadUrl(drive, path), entry?.name || 'file');
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return;
    const count = paths.length;
    const msg = count === 1
      ? `Delete "${paths[0].split('/').pop()}"?`
      : `Delete ${count} items?`;
    if (!confirm(msg)) return;
    const ok = await deleteItems(drive, paths);
    if (ok) {
      setSelectedPaths(new Set());
      navigate(currentPath);
    }
  }

  async function handleRename(entry: FileEntry) {
    setRenameEntry(entry);
    setRenameValue(entry.name);
  }

  async function submitRename() {
    if (!renameEntry || !renameValue.trim()) return;
    const parentDir = renameEntry.path.substring(0, renameEntry.path.lastIndexOf('/')) || '/';
    const newPath = parentDir === '/' ? `/${renameValue}` : `${parentDir}/${renameValue}`;
    const ok = await moveItem(drive, renameEntry.path, newPath);
    if (ok) navigate(currentPath);
    setRenameEntry(null);
    setRenameValue('');
  }

  function handleNewFolder() {
    setNewFolderMode(true);
    setNewFolderName('');
  }

  async function submitNewFolder() {
    if (!newFolderName.trim()) {
      setNewFolderMode(false);
      return;
    }
    const ok = await createFolder(drive, currentPath, newFolderName.trim());
    if (ok) navigate(currentPath);
    setNewFolderMode(false);
    setNewFolderName('');
  }

  function handleUploadClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      if (input.files) processFiles(Array.from(input.files));
    };
    input.click();
  }

  function processFiles(files: File[]) {
    const newUploads: UploadItem[] = files.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: f,
      progress: 0,
      status: 'pending' as const,
      cancelled: false,
    }));
    setUploads((prev) => [...prev, ...newUploads]);

    for (const u of newUploads) {
      setUploads((prev) => prev.map((p) => (p.id === u.id ? { ...p, status: 'uploading' } : p)));
      uploadFile(
        drive,
        currentPath,
        u.file,
        (pct) => {
          setUploads((prev) => prev.map((p) => (p.id === u.id ? { ...p, progress: pct } : p)));
        },
        (abort) => uploadAborts.current.set(u.id, abort),
      ).then((ok) => {
        uploadAborts.current.delete(u.id);
        setUploads((prev) =>
          prev.map((p) => {
            if (p.id !== u.id) return p;
            // A user-cancelled upload keeps its 'error'+cancelled state; don't flip it to 'done'.
            if (p.cancelled) return { ...p, status: 'error' };
            return { ...p, status: ok ? 'done' : 'error', progress: ok ? 100 : p.progress };
          })
        );
        // Refresh the listing after a successful upload (a cancel left nothing new).
        if (ok) navigate(currentPath);
      });
    }
  }

  function cancelUpload(id: string) {
    // Actually abort the transfer, then mark it cancelled.
    uploadAborts.current.get(id)?.();
    uploadAborts.current.delete(id);
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, cancelled: true, status: 'error' } : u)));
  }

  // Drag & drop handlers
  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer?.types.includes('Files')) {
      setDragging(true);
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    if (e.dataTransfer?.files) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  }

  // Check if viewport is mobile-ish
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div
      class="fb"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drive tabs */}
      <div class="fb__tabs">
        {DRIVES.map((d) => (
          <button
            key={d.id}
            class={`fb__tab ${drive === d.id ? 'fb__tab--active' : ''}`}
            onClick={() => setDrive(d.id)}
          >
            <DriveIcon type={d.icon} />
            <span>{d.label}</span>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div class="fb__toolbar">
        {/* Mobile tree toggle */}
        <button
          class="fb__tool-btn fb__tree-toggle"
          onClick={() => setShowTree((v) => !v)}
          aria-label="Toggle tree"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* Breadcrumbs */}
        <nav class="fb__breadcrumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((bc, i) => (
            <span key={bc.path} class="fb__crumb">
              {i > 0 && <span class="fb__crumb-sep">/</span>}
              <button
                class={`fb__crumb-btn ${i === breadcrumbs.length - 1 ? 'fb__crumb-btn--current' : ''}`}
                onClick={() => navigate(bc.path)}
              >
                {bc.label}
              </button>
            </span>
          ))}
        </nav>

        <div class="fb__tool-actions">
          <button class="fb__tool-btn" onClick={handleUploadClick} aria-label="Upload">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17,8 12,3 7,8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span class="fb__tool-label">Upload</span>
          </button>
          <button class="fb__tool-btn" onClick={handleNewFolder} aria-label="New Folder">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span class="fb__tool-label">New Folder</span>
          </button>
          {selectedPaths.size > 0 && (
            <>
              <button
                class="fb__tool-btn"
                onClick={() => {
                  const path = Array.from(selectedPaths)[0];
                  handleDownload(path);
                }}
                aria-label="Download"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span class="fb__tool-label">Download</span>
              </button>
              <button
                class="fb__tool-btn fb__tool-btn--danger"
                onClick={() => handleDelete(Array.from(selectedPaths))}
                aria-label="Delete"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3,6 5,6 21,6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                <span class="fb__tool-label">Delete</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* New folder input */}
      {newFolderMode && (
        <div class="fb__inline-input">
          <input
            type="text"
            class="fb__input"
            placeholder="Folder name"
            value={newFolderName}
            onInput={(e) => setNewFolderName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNewFolder();
              if (e.key === 'Escape') setNewFolderMode(false);
            }}
            autoFocus
          />
          <button class="fb__input-btn" onClick={submitNewFolder}>Create</button>
          <button class="fb__input-btn fb__input-btn--cancel" onClick={() => setNewFolderMode(false)}>Cancel</button>
        </div>
      )}

      {/* Rename input */}
      {renameEntry && (
        <div class="fb__inline-input">
          <span class="text-sm text-muted">Rename:</span>
          <input
            type="text"
            class="fb__input"
            value={renameValue}
            onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') { setRenameEntry(null); setRenameValue(''); }
            }}
            autoFocus
          />
          <button class="fb__input-btn" onClick={submitRename}>Rename</button>
          <button class="fb__input-btn fb__input-btn--cancel" onClick={() => { setRenameEntry(null); setRenameValue(''); }}>Cancel</button>
        </div>
      )}

      {/* Split pane */}
      <div class="fb__panes">
        {showTree && !isMobile && (
          <div class="fb__tree-pane">
            <FileTree drive={drive} currentPath={currentPath} onNavigate={navigate} />
          </div>
        )}
        {showTree && !isMobile && <div class="fb__divider" />}
        <div class="fb__list-pane">
          <FileList
            entries={entries}
            currentPath={currentPath}
            loading={loading}
            selectedPaths={selectedPaths}
            onNavigate={navigate}
            onSelect={setSelectedPaths}
            onDoubleClick={handleDoubleClick}
            onDelete={handleDelete}
            onDownload={handleDownload}
            onRename={handleRename}
          />
        </div>
      </div>

      {/* Drop zone overlay */}
      <DropZone active={dragging} />

      {/* Upload progress panel */}
      <UploadOverlay
        visible={uploads.length > 0}
        uploads={uploads}
        onDismiss={() => setUploads([])}
        onCancel={cancelUpload}
      />

      {/* Audio player */}
      {audioSrc && (
        <AudioPlayer
          src={audioSrc.url}
          fileName={audioSrc.name}
          autoPlay
          onClose={() => setAudioSrc(null)}
        />
      )}
    </div>
  );
}

// --- Helpers ---

function buildBreadcrumbs(path: string): { label: string; path: string }[] {
  const crumbs = [{ label: '~', path: '/' }];
  if (path === '/') return crumbs;

  const parts = path.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function DriveIcon({ type }: { type: string }) {
  switch (type) {
    case 'music':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case 'lightshow':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />
        </svg>
      );
    case 'boombox':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="6" width="20" height="14" rx="2" />
          <circle cx="8" cy="14" r="3" />
          <circle cx="16" cy="14" r="3" />
          <line x1="6" y1="8" x2="18" y2="8" />
        </svg>
      );
    default:
      return null;
  }
}
