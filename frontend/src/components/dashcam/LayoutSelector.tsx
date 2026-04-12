import type { ViewerLayout } from '../../api/types';

const LAYOUTS: { id: ViewerLayout; label: string; cssClass: string; cells: number }[] = [
  { id: 'grid-2x3', label: '2x3 Grid', cssClass: 'lo-grid-2x3', cells: 6 },
  { id: 'grid-3x2', label: '3x2 Grid', cssClass: 'lo-grid-3x2', cells: 6 },
  { id: 'front-focus', label: 'Front Focus', cssClass: 'lo-front-focus', cells: 2 },
  { id: 'single', label: 'Single', cssClass: 'lo-single', cells: 1 },
  { id: 'side-by-side', label: 'Side by Side', cssClass: 'lo-side-by-side', cells: 2 },
  { id: 'picture-in-picture', label: 'PiP', cssClass: 'lo-pip', cells: 1 },
];

interface LayoutSelectorProps {
  layout: ViewerLayout;
  onLayoutChange: (layout: ViewerLayout) => void;
}

export function LayoutSelector({ layout, onLayoutChange }: LayoutSelectorProps) {
  return (
    <div class="layout-selector">
      <span class="layout-selector-label">Layout</span>
      {LAYOUTS.map(l => (
        <button
          key={l.id}
          class={`layout-option ${l.cssClass}${layout === l.id ? ' active' : ''}`}
          onClick={() => onLayoutChange(l.id)}
          title={l.label}
          aria-label={l.label}
        >
          {l.cssClass === 'lo-pip' ? (
            <>
              <div class="lo-cell" style="width:100%;height:100%" />
              <div class="lo-pip-small" />
            </>
          ) : (
            Array.from({ length: l.cells }).map((_, i) => (
              <div key={i} class="lo-cell" />
            ))
          )}
        </button>
      ))}
    </div>
  );
}
