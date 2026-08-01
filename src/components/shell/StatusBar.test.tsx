import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar';
import { useConnectionStore } from '../../stores/connectionStore';

describe('StatusBar', () => {
  it('shows connected label with green dot', () => {
    useConnectionStore.setState({ status: 'connected', lastError: null });
    const { container } = render(<StatusBar />);
    expect(screen.getByText('已连接 rune')).toBeTruthy();
    expect(container.querySelector('.bg-emerald-500')).toBeTruthy();
  });

  it('shows disconnected hint when crush is unreachable', () => {
    useConnectionStore.setState({ status: 'disconnected', lastError: null });
    render(<StatusBar />);
    expect(screen.getByText(/未检测到 crush server/)).toBeTruthy();
  });

  it('shows connecting label', () => {
    useConnectionStore.setState({ status: 'connecting', lastError: null });
    render(<StatusBar />);
    expect(screen.getByText('连接中…')).toBeTruthy();
  });
});
