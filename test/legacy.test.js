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
  assert.equal(v.example({ value: '+1 (212', mask: '_' }), '+1 (212) ___ ____');
  // The value is formatted first, whether it is formatted, raw or half-typed.
  assert.equal(v.mask('212'), '+1 (212) ___ ____');
  assert.equal(v.mask('+1 (212) 5'), '+1 (212) 5__ ____');
  assert.equal(v.mask('2125551234'), '+1 (212) 555 1234');
  assert.equal(v.mask('', { char: '#' }), '+1 (###) ### ####');
  assert.equal(v.mask('21x5'), '+1 (21_) ___ ____'); // stops at the first misfit
  // test.html shipped value="+1 555 123 4567", which valium simply wiped.
  assert.deepEqual(v.fix('+1 555 123 4567'), { value: '+1 (555) 123 4567', ok: true, complete: true, rejected: '' });
  assert.equal(v.fix('2125551234').value, '+1 (212) 555 1234');
  assert.deepEqual(v.fix('212.555.1234', { drop: true }), { value: '+1 (212) 555 1234', ok: false, complete: true, rejected: '..' });
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

test('raw values: unformat(), format() and their lengths', () => {
  const plain = compile(String.raw`\(\d{3}\) \d{3}-\d{4}`);
  assert.equal(plain.minValueLength(), 10);
  assert.equal(plain.maxValueLength(), 10);
  assert.equal(plain.unformat('(212) 555-1234'), '2125551234');
  assert.equal(plain.unformat('(212) 5'), '2125');
  assert.deepEqual(plain.format('2125551234'), { value: '(212) 555-1234', ok: true, complete: true, rejected: '' });
  assert.equal(plain.format('212').value, '(212) ');
  assert.equal(plain.format('').value, '(');
  assert.equal(plain.format('212x').ok, false);

  const v = compile(PHONE);
  assert.equal(v.minValueLength(), 10);
  assert.equal(v.maxValueLength(), 10);
  assert.equal(v.unformat('+1 (212) 555 1234'), '2125551234');

  const zip = compile(ZIP);
  assert.equal(zip.minValueLength(), 5);
  assert.equal(zip.maxValueLength(), 9);
  assert.equal(zip.unformat('12345-6789'), '123456789');
  assert.equal(zip.format('123456789').value, '12345-6789');
  assert.equal(zip.format('12345').value, '12345');
  // fix() also continues through the optional "-" now.
  assert.equal(zip.fix('123456789').value, '12345-6789');

  const date = compile(DATE);
  assert.equal(date.unformat('2024-12-31'), '20241231');
  assert.equal(date.minValueLength(), 8);

  const verbal = compile(VERBAL);
  assert.equal(verbal.unformat('September 5, 2024'), 'S5224');
  assert.equal(verbal.format('S5224').value, 'September 5, 2024');

  assert.equal(compile('\\d+').maxValueLength(), Infinity);
  assert.equal(compile('[]', { mode: 'v' }).minValueLength(), null);
});

test('fix() tells raw from formatted input without being told', () => {
  const plain = compile(String.raw`\(\d{3}\) \d{3}-\d{4}`);
  for (const input of ['2125551234', '(212)555-1234', '(212) 555-1234', '212) 555-1234', '(212) 5551234']) {
    assert.deepEqual(plain.fix(input), { value: '(212) 555-1234', ok: true, complete: true, rejected: '' }, input);
  }
  // A separator the pattern does not have is a misfit too.
  assert.deepEqual(plain.fix('212 555 1234'), { value: '(212) 555', ok: false, complete: false, rejected: ' 1234' });
  // Not a phone number: rejected from the first misfit, like a bad paste.
  assert.deepEqual(plain.fix('212x5551234'), { value: '(212', ok: false, complete: false, rejected: 'x5551234' });
  assert.equal(plain.mask('212x5551234'), '(212) ___-____');

  // Ambiguous: a "1" can be the fixed country code or the first digit.
  const intl = compile(String.raw`\+1 \d{10}`);
  assert.equal(intl.fix('12125551234').value, '+1 2125551234'); // country code typed
  assert.equal(intl.fix('1212555123').value, '+1 1212555123'); // raw number starting with 1
  assert.equal(intl.fix('+1 1212555123').value, '+1 1212555123');
  assert.equal(intl.fix('121').value, '+1 21'); // undecided yet: fewest insertions
});

test('fix() keeps input that already fits, even if another reading completes', () => {
  const v = compile(VERBAL.replace('([1-9]|[12][0-9]|3[01]), ', ''));
  assert.equal(v.fix('January 202').value, 'January 202'); // not "January 2002"
  const intl = compile(String.raw`\+1 \d{10}`);
  assert.equal(intl.fix('1212555123').value, '+1 1212555123'); // still needs a reading
});

test('autoChars(): what valex would have inserted itself', () => {
  assert.deepEqual(compile(ZIP).autoChars('12345-6'), [false, false, false, false, false, false, false]);
  const key = compile(String.raw`[A-Z0-9]{5}(-[A-Z0-9]{5}){4}`);
  assert.deepEqual(key.autoChars('1QWS1-1'), [false, false, false, false, false, true, false]);
  assert.deepEqual(compile(String.raw`\(\d{3}\) \d`).autoChars('(212) 5'), [true, false, false, false, true, true, false]);
});
