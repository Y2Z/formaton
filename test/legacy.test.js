// The patterns from jquery-valium's test.html, including the bugs it listed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../dist/index.js';

const PHONE = String.raw`\+1 \([2-90]\d{2}\) \d{3} \d{4}`;
const ZIP = String.raw`\d{5}([\-]\d{4})?`;
const CARD = String.raw`\d{4} \d{4} \d{4} \d{4}`;
const TIME = String.raw`(0[0-9]|1[0-9]|2[0-3])(:[0-5][0-9]){2}`;
const DATE = String.raw`[12][0-9]{3}-(0[1-9]|1[012])-(0[1-9]|1[0-9]|2[0-9]|3[01])`;
const HEX = String.raw`#?([a-f0-9]{6}|[A-F0-9]{6}|[a-f0-9]{3}|[A-F0-9]{3})`;
const VERBAL = String.raw`(January|February|March|April|May|June|July|August|September|October|November|December) ([1-9]|[12][0-9]|3[01]), (19|20)[0-9][0-9]`;
const CDKEY = String.raw`[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}`;
const EMAIL = String.raw`[a-z0-9\-\.]{1,20}@[a-z0-9\-\.]{1,20}\.(com|co\.uk|co|net|org|ru|su|us|gov)`;

test('US phone: prefix, placeholder, initial value repair', () => {
  const v = compile(PHONE);
  assert.equal(v.prefix(), '+1 (');
  assert.equal(v.example({ mask: '_' }), '+1 (___) ___ ____');
  assert.equal(v.example({ prefix: '+1 (212', mask: '_' }), '+1 (212) ___ ____');
  // test.html shipped value="+1 555 123 4567", which valium simply wiped.
  assert.deepEqual(v.fix('+1 555 123 4567'), { value: '+1 (555) 123 4567', ok: true, complete: true });
  assert.equal(v.fix('2125551234').value, '+1 (212) 555 1234');
  assert.equal(v.fix('212.555.1234', { drop: true }).value, '+1 (212) 555 1234');
  assert.equal(v.forced('+1 (212'), ') ');
  assert.equal(v.maxLength(), 17);
});

test('US phone: "does not erase chunks well"', () => {
  const v = compile(PHONE);
  // Backspace removed the space after ")": the ")" goes too.
  assert.equal(v.trimForced('+1 (212)'), '+1 (212');
  assert.equal(v.trimForced('+1 (212) 555 '), '+1 (212) 555');
  // The forced prefix is trimmed as well; the DOM layer decides whether to keep it.
  assert.equal(v.trimForced('+1 ('), '');
  assert.equal(v.trimForced('+1 (2'), '+1 (2');
});

test('postal code: optional suffix is not forced', () => {
  const v = compile(ZIP);
  assert.equal(v.forced('12345'), '');
  assert.equal(v.allowedNext('12345').single(), '-'.codePointAt(0));
  assert.equal(v.forced('12345-'), '');
  assert.equal(v.minLength(), 5);
  assert.equal(v.maxLength(), 10);
  assert.equal(v.example({ length: 'max', mask: '#' }), '#####-####');
});

test('credit card: spaces inserted', () => {
  const v = compile(CARD);
  assert.equal(v.forced('1234'), ' ');
  assert.equal(v.fix('4111111111111111').value, '4111 1111 1111 1111');
});

test('time: "must show the wildcard as the first digit"', () => {
  const v = compile(TIME);
  assert.equal(v.example({ mask: '_' }), '__:__:__');
  assert.equal(v.forced('12'), ':');
  assert.equal(v.fix('123456').value, '12:34:56');
  assert.equal(v.fix('25').ok, false);
});

test('date: "not putting dashes in this one"', () => {
  const v = compile(DATE);
  assert.equal(v.forced('2024'), '-');
  assert.equal(v.forced('2024-12'), '-');
  assert.equal(v.fix('20241231').value, '2024-12-31');
  assert.equal(v.example({ mask: '_' }), '____-__-__');
  assert.equal(v.isPrefix('2024-13'), false);
  assert.equal(v.isPrefix('3'), false);
});

test('hex color', () => {
  const v = compile(HEX);
  assert.equal(v.prefix(), '');
  assert.ok(v.test('#a0f'));
  assert.ok(!v.test('#a0F'));
  assert.equal(v.maxLength(), 7);
});

test('verbal date: "doesn\'t put \' \' and \', \' between the values"', () => {
  const v = compile(VERBAL);
  assert.equal(v.forced('January'), ' ');
  assert.equal(v.forced('Ja'), 'nuary ');
  assert.equal(v.forced('Se'), 'ptember ');
  assert.equal(v.forced('January 1'), ''); // "1" could be "1" or "10".."19"
  assert.equal(v.forced('January 1,'), ' ');
  assert.equal(v.forced('January 3'), '');
  assert.equal(v.fix('january 5 2024').value, 'January 5, 2024');
});

test('CD key: automatic capitalization and dashes', () => {
  const v = compile(CDKEY);
  assert.equal(v.fix('abcd1234efgh5678').value, 'ABCD-1234-EFGH-5678');
  assert.equal(v.forced('ABCD'), '-');
});

test('email: compiles without the old 9999-string cap', () => {
  const v = compile(EMAIL);
  assert.ok(v.test('me@example.com'));
  assert.ok(v.test('me@example.co.uk'));
  assert.ok(!v.test('me@example.de'));
  // '.' is allowed inside the domain class, so nothing after "co." is forced.
  assert.equal(v.forced('me@example.co.'), '');
  assert.ok(!v.isPrefix('me@exa_mple'));
  assert.equal(v.maxLength(), 47);
});

test('the case valex 0.1.3 failed: [A-Za-z0-9_]{1,15}', () => {
  const v = compile('[A-Za-z0-9_]{1,15}');
  assert.equal(v.minLength(), 1);
  assert.equal(v.maxLength(), 15);
  assert.equal(v.example({ length: 'max', mask: '_' }), '_'.repeat(15));
  assert.ok(v.test('Hello_World_123'));
  assert.ok(!v.test('Hello_World_1234'));
});
