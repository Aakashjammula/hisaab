// Auth cryptography on Web Crypto (available in Workers, Node 20+, Lambda, Deno, Bun).

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Uniform random integer in [0, max) without modulo bias. */
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

/** 6-digit numeric code, e.g. "048213". */
export function generateCode(digits = 6): string {
  return Array.from({ length: digits }, () => randomInt(10)).join('');
}

/** 256-bit session token, URL-safe. Only its hash is stored. */
export function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

/** Keyed hash so a leaked database can't be brute-forced back into 6-digit codes. */
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

/** Compare two equal-length hex strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** UUID v7: time-ordered, so new rows land at the end of indexes. Portable to Postgres `uuid`. */
export function uuidv7(now = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = now;
  for (let i = 5; i >= 0; i--) { b[i] = ts % 256; ts = Math.floor(ts / 256); }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
