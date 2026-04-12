import type { ComponentChildren } from 'preact';

interface EmptyStateProps {
  icon?: ComponentChildren;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div class="empty-state">
      {icon && <div class="empty-state__icon">{icon}</div>}
      <h3 class="empty-state__title">{title}</h3>
      {description && <p class="empty-state__description">{description}</p>}
      {actionLabel && onAction && (
        <button class="empty-state__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}

      <style>{`
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: var(--space-10) var(--space-6);
          text-align: center;
          min-height: 200px;
        }

        .empty-state__icon {
          color: var(--color-text-muted);
          opacity: 0.5;
          margin-bottom: var(--space-4);
        }

        .empty-state__title {
          font-size: var(--text-lg);
          font-weight: var(--font-weight-semibold);
          color: var(--color-text);
          margin-bottom: var(--space-2);
        }

        .empty-state__description {
          font-size: var(--text-sm);
          color: var(--color-text-secondary);
          line-height: var(--leading-relaxed);
          max-width: 360px;
          margin-bottom: var(--space-6);
        }

        .empty-state__action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-2) var(--space-5);
          background: var(--color-accent);
          color: white;
          border: none;
          border-radius: var(--radius-md);
          font-size: var(--text-sm);
          font-weight: var(--font-weight-medium);
          cursor: pointer;
          transition: background var(--transition-fast);
        }

        .empty-state__action:hover {
          background: var(--color-accent-hover);
        }
      `}</style>
    </div>
  );
}
