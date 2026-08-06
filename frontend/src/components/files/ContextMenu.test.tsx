import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

afterEach(cleanup);

const items: ContextMenuItem[] = [
  { label: 'Download', action: () => {} },
  { label: 'Rename', action: () => {} },
  { label: '', action: () => {}, divider: true },
  { label: 'Delete', action: () => {}, danger: true },
];

describe('ContextMenu (keyboard model + roles, iter 42)', () => {
  it('has menu/menuitem roles and focuses the first item on open', () => {
    const { getByRole, getAllByRole } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    );
    expect(getByRole('menu')).toBeTruthy();
    const menuitems = getAllByRole('menuitem');
    expect(menuitems).toHaveLength(3); // divider is a separator, not a menuitem
    expect(document.activeElement).toBe(menuitems[0]);
  });

  it('ArrowDown moves focus to the next item and wraps at the end', () => {
    const { getAllByRole } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    );
    const menuitems = getAllByRole('menuitem');
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuitems[1]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuitems[2]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuitems[0]); // wrapped
  });

  it('End/Home jump to last/first', () => {
    const { getAllByRole } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    );
    const menuitems = getAllByRole('menuitem');
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(menuitems[2]);
    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(menuitems[0]);
  });

  it('Escape closes the menu', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
