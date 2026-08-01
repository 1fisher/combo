const KEY = 'combo.clientId';

// crypto.randomUUID 仅在安全上下文(HTTPS / localhost)可用;局域网
// HTTP 下退化为 crypto.getRandomValues 拼装 RFC 4122 v4 UUID。
export function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getClientId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return randomUUID();
  }
}
