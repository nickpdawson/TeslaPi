import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { Modal } from './Modal';

afterEach(cleanup);

describe('Modal (a11y + double-fire guard, iter 35)', () => {
  it('exposes dialog semantics with a labelled title', () => {
    const { getByRole } = render(
      <Modal open onClose={() => {}} title="Delete Artist">body</Modal>,
    );
    const dialog = getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe('Delete Artist');
  });

  it('pending disables confirm AND cancel so the action cannot double-fire', () => {
    // The double-fire guard is "buttons disabled while pending" — a real browser then
    // suppresses further clicks. (jsdom's fireEvent dispatches to disabled elements
    // anyway, so we assert the disabled state, which is the actual guarantee.)
    const { getByText } = render(
      <Modal open onClose={() => {}} onConfirm={() => {}} title="X" confirmLabel="Delete" pending>body</Modal>,
    );
    expect((getByText('Delete') as HTMLButtonElement).disabled).toBe(true);
    expect((getByText('Cancel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('fires onConfirm when not pending', () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <Modal open onClose={() => {}} onConfirm={onConfirm} title="X" confirmLabel="Delete">body</Modal>,
    );
    fireEvent.click(getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    const { queryByRole } = render(<Modal open={false} onClose={() => {}} title="X">b</Modal>);
    expect(queryByRole('dialog')).toBeNull();
  });
});
