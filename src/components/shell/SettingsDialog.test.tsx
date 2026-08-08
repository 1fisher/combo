import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from './SettingsDialog';
import {
  clearExternalUrl,
  clearProxyUrlOverride,
  getExternalUrl,
  getProxyUrlOverride,
} from '../../lib/connection';

describe('SettingsDialog', () => {
  it('saves the proxy url override to localStorage', async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('http://127.0.0.1:18234');
    await userEvent.clear(input);
    await userEvent.type(input, 'http://10.0.0.5:18234');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getProxyUrlOverride()).toBe('http://10.0.0.5:18234');
    clearProxyUrlOverride();
  });

  it('saves the external domain to localStorage', async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('https://combo.example.com');
    await userEvent.type(input, 'https://combo.example.com');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getExternalUrl()).toBe('https://combo.example.com');
    clearExternalUrl();
  });

  it('clears external domain via 清除域名配置', async () => {
    const { clearExternalUrl: clear } = await import('../../lib/connection');
    clear();
    const { setExternalUrl } = await import('../../lib/connection');
    setExternalUrl('https://combo.example.com');
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '清除域名配置' }));
    expect(getExternalUrl()).toBeNull();
  });
});
