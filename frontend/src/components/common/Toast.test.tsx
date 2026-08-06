import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ToastContainer } from './Toast';
import { notifications } from '../../stores/appState';

afterEach(() => {
  cleanup();
  notifications.value = [];
});

describe('Toast (a11y live regions + dismiss, iter 37)', () => {
  it('announces errors assertively (role=alert) and info/success politely (role=status)', () => {
    notifications.value = [
      { id: 'e', type: 'error', message: 'boom', timestamp: 0 },
      { id: 's', type: 'success', message: 'ok', timestamp: 0 },
    ];
    const { getByText } = render(<ToastContainer />);
    expect(getByText('boom').closest('[role]')?.getAttribute('role')).toBe('alert');
    expect(getByText('ok').closest('[role]')?.getAttribute('role')).toBe('status');
  });

  it('wraps toasts in a labelled region', () => {
    notifications.value = [{ id: 'x', type: 'info', message: 'hi', timestamp: 0 }];
    const { getByRole } = render(<ToastContainer />);
    const region = getByRole('region');
    expect(region.getAttribute('aria-label')).toBe('Notifications');
  });

  it('has a keyboard-reachable dismiss button that removes the toast', () => {
    notifications.value = [{ id: 'x', type: 'info', message: 'hi', timestamp: 0 }];
    const { getByLabelText } = render(<ToastContainer />);
    fireEvent.click(getByLabelText('Dismiss notification'));
    expect(notifications.value.some((n) => n.id === 'x')).toBe(false);
  });

  it('renders nothing when there are no notifications', () => {
    notifications.value = [];
    const { container } = render(<ToastContainer />);
    expect(container.querySelector('.toast-container')).toBeNull();
  });
});
