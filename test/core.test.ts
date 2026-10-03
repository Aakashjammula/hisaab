import { describe, expect, it } from 'vitest';
import { generateCode, generateToken, hmac, isEmail, normalizeEmail, timingSafeEqual, uuidv7 } from '../src/core/crypto.ts';
import { parsePeriod } from '../src/core/dates.ts';

describe('crypto', () => {
  it('codes are 8 digits and vary', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
    for (const c of codes) expect(c).toMatch(/^\d{8}$/);
    expect(codes.size).toBeGreaterThan(190);
  });

  it('tokens carry 256 bits and are URL-safe', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it('uuidv7 is a valid, time-ordered UUID', () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('hmac depends on the secret; comparison is exact', async () => {
    const a = await hmac('secret-one', 'x'), b = await hmac('secret-two', 'x');
    expect(a).not.toBe(b);
    expect(timingSafeEqual(a, a)).toBe(true);
    expect(timingSafeEqual(a, b)).toBe(false);
    expect(timingSafeEqual(a, a.slice(1))).toBe(false);
  });

  it('emails are validated and normalised', () => {
    expect(isEmail(' Me@Example.com ')).toBe(true);
    expect(normalizeEmail(' Me@Example.com ')).toBe('me@example.com');
    for (const bad of ['', 'me', 'me@', '@x.com', 'a b@c.com', 'me@x', 42]) expect(isEmail(bad)).toBe(false);
  });
});

describe('periods', () => {
  it('month in progress, past month, future month', () => {
    expect(parsePeriod({}, '2026-10-02')).toMatchObject({ key: '2026-10', units: 31, elapsed: 2, prev: '2026-09' });
    expect(parsePeriod({ month: '2026-09' }, '2026-10-02')).toMatchObject({ elapsed: 30 });
    expect(parsePeriod({ month: '2026-11' }, '2026-10-02')).toMatchObject({ elapsed: 0 });
  });
  it('year view', () => {
    expect(parsePeriod({ year: '2024' }, '2026-10-02')).toMatchObject({ type: 'year', units: 366, elapsed: 366, prev: '2023' });
  });
});
