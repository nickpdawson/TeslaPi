import type { ComponentChildren } from 'preact';
import { useEffect, useCallback, useRef, useId } from 'preact/hooks';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  children: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
  // While true, the actions are disabled and Escape/overlay-close are blocked, so an
  // in-flight operation (e.g. a delete) can't be double-fired or dismissed mid-run.
  pending?: boolean;
}

export function Modal({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  pending = false,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (!pending) onClose();
      return;
    }
    if (e.key === 'Tab' && cardRef.current) {
      // Trap focus within the dialog.
      const focusables = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose, pending]);

  // Escape + focus-trap listener (re-binds when pending changes).
  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // Focus management + scroll lock (only on open/close, not on pending changes).
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      const focusable = card?.querySelector<HTMLElement>('button:not([disabled])');
      (focusable ?? card)?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = '';
      // Return focus to whatever opened the modal.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div class="modal-overlay" onClick={() => { if (!pending) onClose(); }}>
      <div
        ref={cardRef}
        class="modal-card animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="modal-title" id={titleId}>{title}</h3>
        <div class="modal-body">
          {children}
        </div>
        <div class="modal-actions">
          <button class="btn btn--ghost" onClick={onClose} disabled={pending}>Cancel</button>
          {onConfirm && (
            <button
              class={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
              onClick={onConfirm}
              disabled={pending}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
