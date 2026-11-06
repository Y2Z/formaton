import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharSet, compile, ValexSyntaxError, ValexUnsupportedError } from '../dist/index.js';

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

test('invalid patterns throw ValexSyntaxError', () => {
  for (const p of ['(', 'a{2,1}', '[z-a]', '*a', '\\', '[a-]']) {
    assert.throws(() => compile(p, { mode: 'v' }), ValexSyntaxError, p);
  }
});

test('patterns an automaton cannot model throw ValexUnsupportedError', () => {
  for (const p of ['(a)\\1', '(?<x>a)\\k<x>', '(?=a)a', '(?!a)b', '(?<=a)b', 'a\\bb', 'a{20000}', '\\p{RGI_Emoji}']) {
    assert.throws(() => compile(p, { mode: 'v' }), ValexUnsupportedError, p);
  }
});

test('u mode follows the older class syntax', () => {
  const v = compile('[a-]{2}', { mode: 'u' });
  assert.ok(v.test('a-'));
  assert.throws(() => compile('[a-]', { mode: 'v' }), ValexSyntaxError);
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
