import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharSet, compile, FormatonSyntaxError, FormatonUnsupportedError } from '../dist/index.js';

test('CharSet operations', () => {
  const a = CharSet.fromRanges([
    [10, 20],
    [21, 25],
    [30, 40],
  ]);
  assert.deepEqual(a.ranges(), [
    [10, 25],
    [30, 40],
  ]);
  assert.equal(a.size, 27);
  assert.ok(a.has(25) && !a.has(26) && a.has(30));
  assert.deepEqual(a.intersect(CharSet.range(20, 35)).ranges(), [
    [20, 25],
    [30, 35],
  ]);
  assert.ok(a.complement().complement().equals(a));
  assert.deepEqual(a.minus(CharSet.of(15)).ranges(), [
    [10, 14],
    [16, 25],
    [30, 40],
  ]);
  assert.equal(a.nth(16), 26 + 4);
  assert.equal(CharSet.of(65).single(), 65);
});

test('invalid patterns throw FormatonSyntaxError', () => {
  for (const p of ['(', 'a{2,1}', '[z-a]', '*a', '\\', '[a-]']) {
    assert.throws(() => compile(p, { mode: 'v' }), FormatonSyntaxError, p);
  }
});

test('patterns an automaton cannot model throw FormatonUnsupportedError', () => {
  for (const p of ['(a)\\1', '(?<x>a)\\k<x>', '(?=a)a', '(?!a)b', '(?<=a)b', 'a\\bb', 'a{20000}', '\\p{RGI_Emoji}']) {
    assert.throws(() => compile(p, { mode: 'v' }), FormatonUnsupportedError, p);
  }
});

test('u mode follows the older class syntax', () => {
  const v = compile('[a-]{2}', { mode: 'u' });
  assert.ok(v.test('a-'));
  assert.throws(() => compile('[a-]', { mode: 'v' }), FormatonSyntaxError);
});

test('astral characters count as two UTF-16 units for lengths', () => {
  const v = compile('[\\u{1F600}-\\u{1F64F}]{1,2}', { mode: 'v' });
  assert.equal(v.minLength(), 2);
  assert.equal(v.maxLength(), 4);
  assert.ok(v.test('😀😃'));
});

test('unbounded and empty patterns', () => {
  assert.equal(compile('\\d+').maxLength(), Infinity);
  assert.equal(compile('\\d+').example({ length: 'max' }), '0'); // falls back to shortest
  assert.equal(compile('[]', { mode: 'v' }).example(), null);
  assert.equal(compile('[]', { mode: 'v' }).minLength(), null);
  assert.equal(compile('').example(), '');
  assert.ok(compile('').test(''));
});

test('example() picks readable characters', () => {
  assert.equal(compile('[^0-9]').example(), 'A');
  assert.equal(compile('.').example(), '0');
  const random = () => 0.999;
  assert.equal(compile('[a-c]').example({ random }), 'c');
});

test('allowedNext() and isPrefix()', () => {
  const v = compile('(ab|ac)d');
  assert.equal(v.allowedNext('a').toString(), '[b-c]');
  assert.equal(v.allowedNext('x'), null);
  assert.equal(v.isPrefix('ab'), true);
  assert.equal(v.isPrefix('ad'), false);
});

test('integerRangePattern() matches exactly lo..hi', async () => {
  const { integerRangePattern } = await import('../dist/index.js');
  for (const [lo, hi] of [[0, 0], [0, 9], [1, 12], [0, 59], [7, 7], [5, 123], [10, 99], [100, 999], [1, 1000], [19, 2024], [123, 4567], [0, 99999]]) {
    const v = compile(integerRangePattern(lo, hi));
    for (let n = 0; n <= hi + 50; n++) assert.equal(v.test(String(n)), n >= lo && n <= hi, `${lo}..${hi}: ${n}`);
    assert.ok(!v.test('0' + String(Math.max(lo, 1))), 'no leading zeros');
  }
  // With max 12, "1" can grow but "2" cannot: what type=number auto-advance relies on.
  const month = compile(integerRangePattern(1, 12));
  assert.equal(month.allowedNext('1').isEmpty, false);
  assert.equal(month.allowedNext('2').isEmpty, true);
  assert.throws(() => integerRangePattern(-1, 5), RangeError);
});

test('fix() reports rejected input', () => {
  const v = compile(String.raw`\d{3}-\d{2}`);
  assert.equal(v.fix('12a45').rejected, 'a45');
  assert.equal(v.fix('12a45', { drop: true }).rejected, 'a');
  assert.equal(v.fix('12345').rejected, '');
  assert.equal(v.fix('1234567').rejected, '67');
});

test('unformat() from an offset', () => {
  const v = compile(String.raw`\(\d{3}\) \d{3}`);
  assert.equal(v.unformat('(212) 555', 4), '555');
  assert.equal(v.unformat('(212) 555', 3), '2555');
});

test('masks hide forced characters that follow a choice', () => {
  const dmy = compile(String.raw`(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(19|20)\d{2}`);
  assert.equal(dmy.mask(), '__/__/____'); // not "__/__/_9__"
  assert.equal(compile(String.raw`DE\d{2} \d{4}`).mask(), 'DE__ ____');
  assert.equal(compile(String.raw`0x[0-9a-f]{4}`).mask(), '0x____');
  assert.equal(compile(String.raw`\+1 \(\d{3}\)`).mask(), '+1 (___)');
});
