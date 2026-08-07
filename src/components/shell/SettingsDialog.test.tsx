import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from './SettingsDialog';
import { clearProxyUrlOverride, getProxyUrlOverride, setProxyUrlOverride } from '../../lib/connection';

describe('SettingsDialog', () => {
  it('saves the proxy url override to localStorage', async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('http://127.0.0.1:18234');
    await userEvent.clear(input);
    await userEvent.type(input, 'http://10.0.0.5:18234');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getProxyUrlOverride()).toBe('http://10.0.0.5:18234');
  });

  it('clears the override via 恢复默认', async () => {
    setProxyUrlOverride('http://10.0.0.5:18234');
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(getProxyUrlOverride()).toBeNull();
    clearProxyUrlOverride();
  });
});
