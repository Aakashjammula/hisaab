import { describe, expect, it } from 'vitest';
import { safeNext } from '../public/js/next.js';

const q = next => '?next=' + encodeURIComponent(next);

describe('safeNext', () => {
  it('returns the path and query of a same-origin authorize URL', () => {
    expect(safeNext('?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx', 'https://h')).toBe('/oauth/authorize?client_id=x');
  });

  it.each([
    'https://evil.com/oauth/authorize', '//evil.com/oauth/authorize', '/\\evil.com/oauth/authorize',
    '/api/me', '/oauth/authorizeX', '/oauth/authorize/../../api/me', 'javascript:alert(1)',
  ])('rejects %s', next => expect(safeNext(q(next), 'https://h')).toBeNull());

  it('returns null without next', () => {
    expect(safeNext('', 'https://h')).toBeNull();
    expect(safeNext('?other=1', 'https://h')).toBeNull();
  });
});
