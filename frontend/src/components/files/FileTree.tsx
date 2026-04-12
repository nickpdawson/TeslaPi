import { useState, useCallback } from 'preact/hooks';
import type { FileEntry } from '../../api/types';
import type { Drive } from '../../hooks/useFiles';
import { useFiles } from '../../hooks/useFiles';

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null; // null = not loaded
  expanded: boolean;
}

interface FileTreeProps {
  drive: Drive;
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function FileTree({ drive, currentPath, onNavigate }: FileTreeProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { listFiles } = useFiles();

  // Load root on first render / drive change
  if (!loaded) {
    setLoaded(true);
    listFiles(drive, '/').then((data) => {
      if (data) {
        setRoots(
          data.entries
            .filter((e) => e.isDirectory)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => ({ entry: e, children: null, expanded: false }))
        );
      }
    });
  }

  const toggleNode = useCallback(async (node: TreeNode, path: TreeNode[]) => {
    if (node.expanded) {
      // Collapse
      updateNode(setRoots, path, { ...node, expanded: false });
    } else {
      // Expand and load children if needed
      if (node.children === null) {
        const data = await listFiles(drive, node.entry.path);
        const children = data
          ? data.entries
              .filter((e) => e.isDirectory)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((e) => ({ entry: e, children: null, expanded: false }))
          : [];
        updateNode(setRoots, path, { ...node, children, expanded: true });
      } else {
        updateNode(setRoots, path, { ...node, expanded: true });
      }
    }
  }, [drive, listFiles]);

  return (
    <div class="file-tree">
      <button
        class={`file-tree__node file-tree__node--root ${currentPath === '/' ? 'file-tree__node--active' : ''}`}
        onClick={() => onNavigate('/')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
        <span class="text-sm font-medium">/</span>
      </button>
      {roots.map((node) => (
        <TreeNodeRow
          key={node.entry.path}
          node={node}
          depth={0}
          currentPath={currentPath}
          onNavigate={onNavigate}
          onToggle={toggleNode}
          treePath={[]}
          index={roots.indexOf(node)}
        />
      ))}
    </div>
  );
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  currentPath: string;
  onNavigate: (path: string) => void;
  onToggle: (node: TreeNode, path: TreeNode[]) => void;
  treePath: TreeNode[];
  index: number;
}

function TreeNodeRow({ node, depth, currentPath, onNavigate, onToggle, treePath, index: _index }: TreeNodeRowProps) {
  void _index;
  const isActive = currentPath === node.entry.path;
  const hasChildren = node.children === null || node.children.length > 0;
  const fullPath = [...treePath, node];

  return (
    <div class="file-tree__branch">
      <div
        class={`file-tree__node ${isActive ? 'file-tree__node--active' : ''}`}
        style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
      >
        <button
          class={`file-tree__arrow ${node.expanded ? 'file-tree__arrow--open' : ''} ${!hasChildren ? 'file-tree__arrow--hidden' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node, fullPath);
          }}
          aria-label={node.expanded ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6,4 10,8 6,12" />
          </svg>
        </button>
        <button
          class="file-tree__label"
          onClick={() => onNavigate(node.entry.path)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {node.expanded ? (
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            ) : (
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            )}
          </svg>
          <span class="text-sm truncate">{node.entry.name}</span>
        </button>
      </div>
      {node.expanded && node.children && (
        <div class="file-tree__children">
          {node.children.map((child, i) => (
            <TreeNodeRow
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onNavigate={onNavigate}
              onToggle={onToggle}
              treePath={fullPath}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Immutable tree update helper
function updateNode(
  setRoots: (fn: (prev: TreeNode[]) => TreeNode[]) => void,
  path: TreeNode[],
  updated: TreeNode,
) {
  setRoots((prev) => {
    if (path.length === 0) {
      // Root level
      return prev.map((n) => (n.entry.path === updated.entry.path ? updated : n));
    }
    return prev.map((n) => updateRecursive(n, path, 0, updated));
  });
}

function updateRecursive(node: TreeNode, path: TreeNode[], depth: number, updated: TreeNode): TreeNode {
  if (depth >= path.length) {
    // We're at the parent — update the matching child
    if (!node.children) return node;
    return {
      ...node,
      children: node.children.map((c) =>
        c.entry.path === updated.entry.path ? updated : c
      ),
    };
  }
  if (node.entry.path === path[depth].entry.path) {
    if (depth === path.length - 1) {
      // This node is the direct parent
      if (!node.children) return node;
      return {
        ...node,
        children: node.children.map((c) =>
          c.entry.path === updated.entry.path ? updated : c
        ),
      };
    }
    // Recurse deeper
    return {
      ...node,
      children: node.children
        ? node.children.map((c) => updateRecursive(c, path, depth + 1, updated))
        : null,
    };
  }
  return node;
}
