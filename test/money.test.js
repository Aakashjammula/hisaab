import { describe, expect, it } from 'vitest';
import { cleanAmountInput, formatINR, formatShort, splitShare, toPaise, toRupeeString } from '../public/js/money.js';
import { suggestIcon } from '../public/js/icon-list.js';

describe('toPaise', () => {
  it.each([
    ['1000', 100000], ['19.99', 1999], ['4.35', 435], ['0.07', 7], ['1000.5', 100050],
    ['1,23,456.78', 12345678], ['₹ 250', 25000], ['  12 ', 1200], ['100.', 10000], [1000, 100000],
  ])('%s -> %i paise', (input, paise) => expect(toPaise(input)).toBe(paise));

  it.each(['1.005', 'abc', '', '-5', '1e3', '12.3.4', '.5', null, undefined, '1000000000000'])(
    'rejects %s', input => expect(toPaise(input)).toBeNull());
});

describe('splitShare', () => {
  it('splits equally and the remainder is "others"', () => {
    expect(splitShare(100000, 5)).toBe(20000);
    const mine = splitShare(100000, 3);
    expect(mine).toBe(33333);
    expect(100000 - mine).toBe(66667); // always adds up to what was paid
  });
});

describe('formatting', () => {
  it('formats with Indian grouping', () => {
    expect(formatINR(1234567800)).toBe('₹1,23,45,678');
    expect(formatINR(1234550)).toBe('₹12,345.50');
    expect(formatShort(420000)).toBe('₹4.2k');
    expect(formatShort(45000)).toBe('₹450');
    expect(formatShort(12000000)).toBe('₹1.2L');
    expect(toRupeeString(100050)).toBe('1000.50');
    expect(toRupeeString(100000)).toBe('1000');
  });
});

describe('suggestIcon', () => {
  it.each([['Gym', 'dumbbell'], ['Coffee', 'coffee'], ['Petrol', 'fuel'], ['Netflix', 'tv-minimal-play'], ['Zxqv', 'tag']])(
    '%s -> %s', (name, icon) => expect(suggestIcon(name)).toBe(icon));
});

describe('cleanAmountInput', () => {
  it.each([
    ['dwdwdwdw', ''], ['1a2b3', '123'], ['12.345', '12.34'], ['1.2.3', '1.23'], ['.5', '0.5'],
    ['₹1,000', '1000'], ['-50', '50'], ['123456789', '1234567'], ['1e5', '15'], ['249.50', '249.50'],
  ])('%s -> %s', (input, out) => expect(cleanAmountInput(input)).toBe(out));
});
