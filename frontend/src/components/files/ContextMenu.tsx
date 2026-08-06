import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface ContextMenuItem {
  label: string;
  icon?: ComponentChildren;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function enabledItems(): HTMLButtonElement[] {
      return Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('.ctx-menu__item:not([disabled])') ?? [],
      );
    }
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const buttons = enabledItems();
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        buttons[(current + 1 + buttons.length) % buttons.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(current - 1 + buttons.length) % buttons.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        buttons[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        buttons[buttons.length - 1].focus();
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Move focus into the menu (first enabled item) once on open, so it's keyboard-
  // operable immediately. Mount-only so a parent re-render can't yank focus back.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('.ctx-menu__item:not([disabled])')?.focus();
  }, []);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      class="ctx-menu"
      role="menu"
      aria-label="File actions"
      tabIndex={-1}
      style={{ top: `${y}px`, left: `${x}px` }}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={i} class="ctx-menu__divider" role="separator" />;
        }
        return (
          <button
            key={i}
            role="menuitem"
            tabIndex={-1}
            class={`ctx-menu__item ${item.danger ? 'ctx-menu__item--danger' : ''} ${item.disabled ? 'ctx-menu__item--disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            disabled={item.disabled}
          >
            {item.icon && <span class="ctx-menu__icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
