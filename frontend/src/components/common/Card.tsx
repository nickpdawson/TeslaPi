import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

interface CardProps {
  title?: string;
  icon?: ComponentChildren;
  children: ComponentChildren;
  className?: string;
  expandable?: boolean;
  expandContent?: ComponentChildren;
  onExpand?: (expanded: boolean) => void;
}

export function Card({
  title,
  icon,
  children,
  className = '',
  expandable = false,
  expandContent,
  onExpand,
}: CardProps) {
  const [expanded, setExpanded] = useState(false);

  function handleExpand() {
    const next = !expanded;
    setExpanded(next);
    onExpand?.(next);
  }

  return (
    <div class={`card ${className}`}>
      {title && (
        <div class="card__header">
          {icon && <span class="card__icon">{icon}</span>}
          <span class="card__title">{title}</span>
          {expandable && (
            <button
              class={`card__expand-btn ${expanded ? 'card__expand-btn--open' : ''}`}
              onClick={handleExpand}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4,6 8,10 12,6" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div class="card__body">
        {children}
      </div>
      {expandable && expandContent && (
        <div class={`card__expandable ${expanded ? 'card__expandable--open' : ''}`}>
          <div style={{ paddingTop: 'var(--space-4)', borderTop: '1px solid var(--color-border)' }}>
            {expandContent}
          </div>
        </div>
      )}
    </div>
  );
}
