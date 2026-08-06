import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { FileList } from './FileList';
import type { FileEntry } from '../../api/types';

afterEach(cleanup);

const entries: FileEntry[] = [
  { name: 'Album A', path: '/Album A', isDirectory: true, size: 0, modified: '2026-01-01T00:00:00Z' },
  { name: 'song.mp3', path: '/song.mp3', isDirectory: false, size: 123, modified: '2026-01-02T00:00:00Z' },
];

function renderList(selected: string[] = []) {
  return render(
    <FileList
      entries={entries}
      currentPath="/"
      loading={false}
      selectedPaths={new Set(selected)}
      onNavigate={() => {}}
      onSelect={() => {}}
      onDoubleClick={() => {}}
      onDelete={() => {}}
      onDownload={() => {}}
      onRename={() => {}}
    />,
  );
}

describe('FileList (listbox roles + active-descendant, iter 41)', () => {
  it('is a labelled listbox whose rows are options', () => {
    const { getByRole, getAllByRole } = renderList();
    expect(getByRole('listbox').getAttribute('aria-label')).toBe('Files');
    const options = getAllByRole('option');
    // The rows are sorted dirs-first; both entries render as options.
    expect(options).toHaveLength(2);
  });

  it('marks the selected row aria-selected and points aria-activedescendant at it', () => {
    // Select the file; after dirs-first sort it is the 2nd row (index 1 -> file-row-1).
    const { getByRole, getAllByRole } = renderList(['/song.mp3']);
    const options = getAllByRole('option');
    const selected = options.find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toContain('song.mp3');
    expect(getByRole('listbox').getAttribute('aria-activedescendant')).toBe(selected?.id);
  });

  it('has no active-descendant when nothing is selected', () => {
    const { getByRole } = renderList();
    expect(getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull();
  });
});
