import { describe, expect, it } from 'vitest';
import { useConnectionStore } from './connectionStore';

describe('connectionStore', () => {
  it('tracks status transitions', () => {
    const s = useConnectionStore.getState();
    s.setStatus('connecting');
    expect(useConnectionStore.getState().status).toBe('connecting');
    s.setStatus('connected');
    expect(useConnectionStore.getState().status).toBe('connected');
    s.setError('boom');
    expect(useConnectionStore.getState().lastError).toBe('boom');
  });
});
