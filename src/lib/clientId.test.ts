import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientId, randomUUID } from './clientId';

const originalRandomUUID = crypto.randomUUID;

describe('clientId', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof crypto.randomUUID === 'function' && !originalRandomUUID) {
      // noop
    }
    Object.defineProperty(crypto, 'randomUUID', {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
  });

  it('persists the id in localStorage', () => {
    const a = getClientId();
    const b = getClientId();
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('falls back to getRandomValues when randomUUID is unavailable (insecure context)', () => {
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const id = randomUUID();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    // getClientId 在 fallback 下同样持久化并复用同一 id
    expect(getClientId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(getClientId()).toBe(getClientId());
  });
});
