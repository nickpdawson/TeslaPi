import type { ComponentChildren } from 'preact';
import { useEffect, useCallback } from 'preact/hooks';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  children: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
}

export function Modal({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger = false }: ModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal-card animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <h3 class="modal-title">{title}</h3>
        <div class="modal-body">
          {children}
        </div>
        <div class="modal-actions">
          <button class="btn btn--ghost" onClick={onClose}>Cancel</button>
          {onConfirm && (
            <button
              class={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
