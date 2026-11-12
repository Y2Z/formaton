// Drives the DOM binding with real keystrokes in Chromium.
// Needs Playwright with Chromium installed: npm run test:browser
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

let server;
let browser;
let page;
let base;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

beforeEach(async () => {
  page = await browser.newPage({ locale: 'en-US' });
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(`${base}/test/browser/page.html`);
  await page.waitForFunction(() => window.ready);
});

const value = (id) => page.$eval(`#${id}`, (el) => el.value);
const events = () => page.evaluate(() => window.events.splice(0));
const active = () => page.evaluate(() => document.activeElement?.id ?? null);
const caret = (id, pos) => page.$eval(`#${id}`, (el, p) => el.setSelectionRange(p, p), pos);
const type = async (text) => {
  for (const ch of text) await page.keyboard.type(ch);
};

test('placeholder and maxlength come from the pattern', async () => {
  assert.equal(await page.getAttribute('#phone', 'placeholder'), '(___) ___-____');
  assert.equal(await page.getAttribute('#phone', 'maxlength'), null); // opt-in
  // Nothing fixed to show in a ZIP mask, so no placeholder.
  assert.equal(await page.getAttribute('#zip', 'placeholder'), null);
  assert.equal(await page.evaluate(() => window.bindings.plain.kind), 'none');
  assert.equal(await page.evaluate(() => window.bindings.date.kind), 'native');
});

test('typing a phone number inserts separators, fires onFilled and advances', async () => {
  await page.focus('#phone');
  assert.equal(await value('phone'), '(');
  await type('212');
  assert.equal(await value('phone'), '(212) ');
  await type('5551234');
  assert.equal(await value('phone'), '(212) 555-1234');
  assert.deepEqual(await events(), [['filled', 'phone', '(212) 555-1234']]);
  assert.equal(await active(), 'zip');
  assert.equal(await page.evaluate(() => window.bindings.phone.rawValue), '2125551234');
});

test('typed separators are accepted where they belong, others rejected', async () => {
  await page.focus('#phone');
  // The user types ") " although formaton already inserted it.
  await type('212) 555-');
  assert.equal(await value('phone'), '(212) 555-');
  await type('x');
  assert.equal(await value('phone'), '(212) 555-');
  assert.deepEqual(await events(), [['reject', 'phone', 'x']]);
});

test('typing past the end is rejected', async () => {
  await page.focus('#phone');
  await type('2125551234');
  await events();
  await page.focus('#phone');
  await page.keyboard.press('End');
  await type('9');
  assert.equal(await value('phone'), '(212) 555-1234');
  assert.deepEqual(await events(), [['reject', 'phone', '9']]);
});

test('backspace keeps separators formaton would add back, and removes them with the digit before', async () => {
  await page.focus('#phone');
  await type('2125');
  assert.equal(await value('phone'), '(212) 5');
  await page.keyboard.press('Backspace');
  assert.equal(await value('phone'), '(212) ');
  await page.keyboard.press('Backspace');
  assert.equal(await value('phone'), '(21');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  // The prefix stays while the field has focus, and goes on blur.
  assert.equal(await value('phone'), '(');
  await page.focus('#go');
  assert.equal(await value('phone'), '');
});

test('product key: backspace after a dash', async () => {
  await page.focus('#key');
  await type('1qws1-1');
  assert.equal(await value('key'), '1QWS1-1');
  await page.keyboard.press('Backspace');
  assert.equal(await value('key'), '1QWS1-');
  await page.keyboard.press('Backspace');
  assert.equal(await value('key'), '1QWS');
  await type('1');
  assert.equal(await value('key'), '1QWS1-');
  await type('-'); // already there: stepped over
  assert.equal(await value('key'), '1QWS1-');
  await type('2');
  assert.equal(await value('key'), '1QWS1-2');
});

test('pasting raw or formatted text', async () => {
  await page.focus('#phone');
  await page.keyboard.insertText('2125551234');
  assert.equal(await value('phone'), '(212) 555-1234');
  assert.equal(await active(), 'zip');
  await page.$eval('#phone', (el) => (el.value = ''));
  await page.evaluate(() => (window.bindings.phone.rawValue = ''));
  await page.focus('#phone');
  await page.keyboard.insertText('(212) 555-12');
  assert.equal(await value('phone'), '(212) 555-12');
  await page.keyboard.insertText('3x4');
  assert.equal(await value('phone'), '(212) 555-123');
  const ev = await events();
  assert.deepEqual(ev.at(-1), ['reject', 'phone', 'x4']);
});

test('typing in the middle: shift while there is room, overwrite once filled', async () => {
  await page.focus('#phone');
  await type('21255512');
  await caret('phone', 3); // after "(21"
  await type('9');
  assert.equal(await value('phone'), '(219) 255-512');
  await page.keyboard.press('End');
  await type('3');
  assert.deepEqual((await events()).at(-1), ['filled', 'phone', '(219) 255-5123']);
  await page.focus('#phone');
  await caret('phone', 3); // now filled: overwrite
  await type('0');
  assert.equal(await value('phone'), '(210) 255-5123');
  // The caret steps over ") " to the next digit.
  assert.equal(await page.$eval('#phone', (el) => el.selectionStart), 6);
  await type('87');
  assert.equal(await value('phone'), '(210) 875-5123');
  await page.keyboard.press('Backspace'); // deleting still pulls the rest back
  assert.equal(await value('phone'), '(210) 855-123');
  assert.equal(await page.$eval('#phone', (el) => el.selectionStart), 7);
});

test('editMode shift: the rest moves along', async () => {
  await page.focus('#shift');
  await type('2125551234');
  await page.focus('#shift');
  await caret('shift', 3);
  await type('9');
  assert.equal(await value('shift'), '(219) 255-5123');
  assert.equal(await page.$eval('#shift', (el) => el.selectionStart), 6);
});

test('editMode truncate: the rest is cleared', async () => {
  await page.focus('#truncate');
  await type('2125551234');
  await page.focus('#truncate');
  await caret('truncate', 3);
  await type('9');
  assert.equal(await value('truncate'), '(219) ');
  assert.equal(await page.$eval('#truncate', (el) => el.selectionStart), 6);
});

test('a rejected character leaves value and caret alone', async () => {
  await page.focus('#time');
  await type('1234');
  assert.equal(await value('time'), '12:34');
  await page.focus('#time');
  await caret('time', 3); // after ":"
  await type('7'); // minutes cannot start with 7
  assert.equal(await value('time'), '12:34');
  assert.equal(await page.$eval('#time', (el) => el.selectionStart), 3);
  assert.deepEqual((await events()).at(-1), ['reject', 'time', '7']);
  await type('5');
  assert.equal(await value('time'), '12:54');
  assert.equal(await page.$eval('#time', (el) => el.selectionStart), 4);
  await caret('time', 2); // before ":": typing ":" steps over it
  await type(':');
  assert.equal(await value('time'), '12:54');
  assert.equal(await page.$eval('#time', (el) => el.selectionStart), 3);
});

test('re-typing the end of a filled value fires onFilled and advances again', async () => {
  await page.focus('#time');
  await type('1245');
  assert.deepEqual(await events(), [['filled', 'time', '12:45']]);
  assert.equal(await active(), 'shift');
  await page.focus('#time');
  await caret('time', 3);
  await type('5'); // "12:55", caret before the last digit: stay
  assert.equal(await value('time'), '12:55');
  assert.deepEqual(await events(), []);
  assert.equal(await active(), 'time');
  await type('7'); // "12:57", caret at the end: done again
  assert.deepEqual(await events(), [['filled', 'time', '12:57']]);
  assert.equal(await active(), 'shift');
});

test('ZIP+4: the optional dash can be typed again after deleting it', async () => {
  await page.focus('#zip');
  await type('123456789');
  assert.equal(await value('zip'), '12345-6789');
  await page.focus('#zip');
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  assert.equal(await value('zip'), '12345-');
  await page.keyboard.press('Backspace');
  assert.equal(await value('zip'), '12345'); // the dash is optional, so it goes
  await type('-');
  assert.equal(await value('zip'), '12345-');
  await type('4321');
  assert.equal(await value('zip'), '12345-4321');
  assert.deepEqual((await events()).filter((e) => e[0] === 'reject'), []);
});

test('type=email keeps the caret where it was', async () => {
  await page.focus('#email');
  await type('me@website');
  // type=email has no selection API: move the caret with the keyboard.
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowLeft');
  await type('-'); // a domain cannot start with "-"
  assert.equal(await value('email'), 'me@website');
  await type('my'); // still right after "@"
  assert.equal(await value('email'), 'me@mywebsite');
  assert.deepEqual(await events(), [['reject', 'email', '-']]);
});

test('type=email: the caret stays put next to identical characters', async () => {
  await page.focus('#email');
  await type('me@company');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft'); // after "me@co"
  await type('m');
  await type('X'); // shows where the caret is
  assert.equal(await value('email'), 'me@comXmpany');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await type('Z');
  assert.equal(await value('email'), 'me@coZmpany');
});

test('optional parts: a ZIP code is filled only when it cannot grow', async () => {
  await page.focus('#zip');
  await type('12345');
  assert.deepEqual(await events(), []);
  await type('6789');
  assert.equal(await value('zip'), '12345-6789');
  assert.deepEqual(await events(), [['filled', 'zip', '12345-6789']]);
});

test('prefix on focus, country code ambiguity', async () => {
  await page.focus('#intl');
  assert.equal(await value('intl'), '+1 ');
  await type('2125551234');
  assert.equal(await value('intl'), '+1 2125551234');
  assert.equal(await active(), 'cd');
});

test('case is corrected', async () => {
  await page.focus('#cd');
  await type('abcd1234');
  assert.equal(await value('cd'), 'ABCD-1234');
  assert.equal(await active(), 'email');
});

test('type=email works without a selection API', async () => {
  await page.focus('#email');
  await type('me@example.com');
  assert.equal(await value('email'), 'me@example.com');
  await type(',');
  assert.equal(await value('email'), 'me@example.com');
  assert.deepEqual(await events(), [['reject', 'email', ',']]);
});

test('type=number with min/max: final digit advances, impossible digits revert', async () => {
  await page.focus('#month');
  // Characters a number field accepts but the range never uses do not get in.
  await type('-');
  await type('e');
  assert.deepEqual(await events(), [
    ['reject', 'month', '-'],
    ['reject', 'month', 'e'],
  ]);
  await type('1');
  assert.deepEqual(await events(), []); // could still become 10..12
  await type('3');
  assert.equal(await value('month'), '1');
  await type('a');
  assert.equal(await value('month'), '1');
  assert.deepEqual(await events(), [
    ['reject', 'month', '3'],
    ['reject', 'month', 'a'],
  ]);
  await type('2');
  assert.equal(await value('month'), '12');
  assert.deepEqual(await events(), [['filled', 'month', '12']]);
  assert.equal(await active(), 'date');
});

test('type=date fires once, when the year is complete', async () => {
  await page.focus('#date');
  for (const k of '12312024') await page.keyboard.press(k);
  assert.equal(await value('date'), '2024-12-31');
  assert.deepEqual(await events(), [['filled', 'date', '2024-12-31']]);
});

test('detach removes listeners and added attributes', async () => {
  await page.evaluate(() => window.bindings.phone.detach());
  assert.equal(await page.getAttribute('#phone', 'placeholder'), null);
  await page.focus('#phone');
  await type('212');
  assert.equal(await value('phone'), '212');
});

test('backspace and delete next to a separator in the middle', async () => {
  await page.focus('#shift');
  await type('2125551234');
  await page.focus('#shift');
  await caret('shift', 6); // after "(212) ": the character before is a separator
  await page.keyboard.press('Backspace');
  assert.equal(await value('shift'), '(215) 551-234');
  assert.equal(await page.$eval('#shift', (el) => el.selectionStart), 3);
  await caret('shift', 4); // before ")": Delete takes the next digit instead
  await page.keyboard.press('Delete');
  assert.equal(await value('shift'), '(215) 512-34');
  assert.equal(await page.$eval('#shift', (el) => el.selectionStart), 4);
});

test('typing over a selection replaces it', async () => {
  await page.focus('#phone');
  await type('2125551234');
  await page.focus('#phone');
  await page.$eval('#phone', (el) => el.setSelectionRange(1, 4)); // "212"
  await type('3');
  assert.equal(await value('phone'), '(355) 512-34');
  assert.equal(await page.$eval('#phone', (el) => el.selectionStart), 2);
  await page.keyboard.press('Control+A');
  await type('9');
  assert.equal(await value('phone'), '(9');
});

test('a digit matching part of the prefix is not swallowed by it', async () => {
  await page.focus('#us');
  assert.equal(await value('us'), '+1 (');
  await type('1'); // area codes cannot start with 1
  assert.equal(await value('us'), '+1 (');
  await type('0');
  assert.equal(await value('us'), '+1 (');
  assert.deepEqual(await events(), [
    ['reject', 'us', '1'],
    ['reject', 'us', '0'],
  ]);
  await type('2');
  assert.equal(await value('us'), '+1 (2');
});

test('typing the prefix out of habit still works', async () => {
  await page.focus('#us');
  await type('+1 (212) 555-1234');
  assert.equal(await value('us'), '+1 (212) 555-1234');
  assert.deepEqual(await events(), [['filled', 'us', '+1 (212) 555-1234']]);
  await page.focus('#us');
  await page.keyboard.press('Control+A');
  await type('+12125551234');
  assert.equal(await value('us'), '+1 (212) 555-1234');
});

test('where a 1 can follow the prefix, it is a digit', async () => {
  await page.focus('#intl');
  assert.equal(await value('intl'), '+1 ');
  await type('1');
  assert.equal(await value('intl'), '+1 1');
  assert.deepEqual(await events(), []);
});

test('an auto-inserted separator can be typed over once, not twice', async () => {
  await page.focus('#ymd');
  await type('2012');
  assert.equal(await value('ymd'), '2012-');
  await type('-'); // habit: absorbed
  assert.equal(await value('ymd'), '2012-');
  assert.deepEqual(await events(), []);
  await type('-'); // a second one is a mistake
  assert.equal(await value('ymd'), '2012-');
  assert.deepEqual(await events(), [['reject', 'ymd', '-']]);
  await type('1');
  assert.equal(await value('ymd'), '2012-1');
  // Typed with its dashes from the start, the same.
  await page.keyboard.press('Control+A');
  await type('2012-');
  await type('-');
  assert.equal(await value('ymd'), '2012-');
  assert.deepEqual(await events(), [['reject', 'ymd', '-']]);
});

test('separators are not absorbed after the caret moved away', async () => {
  await page.focus('#phone');
  await type('212');
  assert.equal(await value('phone'), '(212) ');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await type(' ');
  assert.equal(await value('phone'), '(212) ');
  assert.deepEqual(await events(), [['reject', 'phone', ' ']]);
});

test('deleting before the separator keeps it and the caret', async () => {
  await page.focus('#time');
  await type('222');
  assert.equal(await value('time'), '22:2');
  await caret('time', 1);
  await page.keyboard.press('Backspace'); // removes the first "2"
  assert.equal(await value('time'), '22:');
  assert.equal(await page.$eval('#time', (el) => el.selectionStart), 0);
  await page.keyboard.press('Delete');
  assert.equal(await value('time'), '2');
  assert.equal(await page.$eval('#time', (el) => el.selectionStart), 0);
});

test('fuzz: Backspace and Delete anywhere remove one chosen character, caret in place', async () => {
  const { compile } = await import('../../dist/index.js');
  const cases = [
    [String.raw`\d{4} \d{4} \d{4} \d{4}`, '0000000000000000'],
    [String.raw`\d{4} \d{4} \d{4} \d{4}`, '1234567890123456'],
    [String.raw`[A-Z0-9]{5}(-[A-Z0-9]{5}){4}`, '0'.repeat(25)],
    [String.raw`\+1 \([2-9]\d{2}\) \d{3}-\d{4}`, '2125551234'],
    [String.raw`([01]\d|2[0-3]):[0-5]\d`, '2359'],
  ];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  await page.evaluate(async () => {
    const { attach } = await import('/dist/index.js');
    const el = document.createElement('input');
    el.id = 'fuzz';
    document.body.prepend(el);
    window.fuzzWith = (pattern) => {
      window.fuzzBinding?.detach();
      el.value = '';
      window.fuzzBinding = attach(el, { pattern });
    };
  });
  const problems = [];
  for (const [pattern, fill] of cases) {
    const v = compile(pattern);
    for (let round = 0; round < 12; round++) {
      await page.evaluate((p) => window.fuzzWith(p), pattern);
      await page.focus('#fuzz');
      await type(fill);
      for (let step = 0; step < 8; step++) {
        const before = await value('fuzz');
        const c = Math.floor(rnd() * (before.length + 1));
        await caret('fuzz', c);
        const key = rnd() < 0.7 ? 'Backspace' : 'Delete';
        await page.keyboard.press(key);
        const [after, at] = await page.$eval('#fuzz', (el) => [el.value, el.selectionStart]);
        // Model: the user's characters (not separators formaton inserted), minus the one the key removes.
        const auto = v.autoChars(before);
        const free = [...before].map((_, i) => i).filter((i) => !auto[i]);
        const k = free.filter((i) => i < c).length - (key === 'Backspace' ? 1 : 0);
        if (k < 0 || k >= free.length) continue; // nothing of the user's to remove that way
        const raw = free.map((i) => before[i]);
        raw.splice(k, 1);
        // What does not fit any more after the deletion is dropped, as when pasting.
        const fixed = v.fix(raw.join(''), { drop: true }).value;
        const want = fixed + v.forced(fixed);
        const wantAt = key === 'Backspace' ? free[k] : c;
        if (after !== want || at !== wantAt) problems.push(`${pattern}: ${key} at ${c} of ${before} gave ${after}|${at}, want ${want}|${wantAt}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('replacing a digit keeps the separators that follow it', async () => {
  await page.focus('#us');
  await type('234');
  assert.equal(await value('us'), '+1 (234) ');
  await page.$eval('#us', (el) => el.setSelectionRange(4, 5)); // the "2"
  await type('5');
  assert.equal(await value('us'), '+1 (534) ');
  assert.equal(await page.$eval('#us', (el) => el.selectionStart), 5);
  await page.$eval('#us', (el) => el.setSelectionRange(4, 5));
  await type('5'); // the same digit again
  assert.equal(await value('us'), '+1 (534) ');
  await caret('us', 5);
  await page.keyboard.press('Backspace'); // two digits left: no ") " yet
  assert.equal(await value('us'), '+1 (34');
});

test('a misfit typed over a selection keeps both', async () => {
  await page.focus('#ymd');
  await type('20001111');
  assert.equal(await value('ymd'), '2000-11-11');
  await events();
  await page.focus('#ymd');
  await page.$eval('#ymd', (el) => el.setSelectionRange(5, 6)); // first "1" of the month
  await type('2'); // no month 21
  assert.equal(await value('ymd'), '2000-11-11');
  assert.deepEqual(await page.$eval('#ymd', (el) => [el.selectionStart, el.selectionEnd]), [5, 6]);
  assert.deepEqual(await events(), [['reject', 'ymd', '2']]);
  assert.equal(await page.evaluate(() => window.bindings.ymd.filled), true);
  await type('0'); // fits: replaces it
  assert.equal(await value('ymd'), '2000-01-11');
});

test('a completed word gets the separator the next part needs', async () => {
  await page.focus('#mon');
  await type('Ja');
  assert.equal(await value('mon'), 'January ');
  await type('2');
  assert.equal(await value('mon'), 'January 20');
  await page.keyboard.press('Control+A');
  await type('September 1999'); // typed in full: the auto-completed part is typed over
  assert.equal(await value('mon'), 'September 1999');
  assert.deepEqual((await events()).filter((e) => e[0] === 'reject'), []);
});
test('a key re-typing what the last field auto-completed does not land in the next one', async () => {
  await page.focus('#t12');
  await type('930p'); // formaton adds the "M", the value is complete, focus moves on
  assert.equal(await value('t12'), '9:30PM');
  assert.equal(await active(), 'word');
  await type('m'); // habit: the "M" of "PM"
  assert.equal(await value('word'), '');
  await type('m'); // a second one is meant for this field
  assert.equal(await value('word'), 'm');
});

test('placeholders only where every value has that shape', async () => {
  const ph = (id) => page.getAttribute(`#${id}`, 'placeholder');
  assert.equal(await ph('ymd'), '____-__-__');
  assert.equal(await ph('us'), '+1 (___) ___-____');
  assert.equal(await ph('t12'), null); // "9:30PM" and "09:30 PM" differ in length
  assert.equal(await ph('mon'), null);
});

test('rawValue of a number field is its value', async () => {
  await page.focus('#pct');
  await type('100');
  assert.equal(await page.evaluate(() => window.bindings.pct.rawValue), '100');
});

test('complete vs filled: a 3-digit CVV is valid, a 4-digit one is also full', async () => {
  const state = () => page.evaluate(() => [window.bindings.cvv.complete, window.bindings.cvv.filled]);
  await page.focus('#cvv');
  await type('12');
  assert.deepEqual(await state(), [false, false]);
  await type('3');
  assert.deepEqual(await state(), [true, false]); // valid, may grow: no jump
  assert.deepEqual(await page.evaluate(() => window.completes.splice(0)), [['cvv', '123']]);
  assert.equal(await active(), 'cvv');
  await type('4');
  assert.deepEqual(await state(), [true, true]);
  assert.deepEqual(await events(), [['filled', 'cvv', '1234']]);
  await page.focus('#cvv');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.deepEqual(await state(), [false, false]);
});

test('a ZIP code is complete after five digits', async () => {
  await page.focus('#zip');
  await type('12345');
  assert.equal(await page.evaluate(() => window.bindings.zip.complete), true);
  assert.equal(await page.evaluate(() => window.bindings.zip.filled), false);
  assert.equal(await active(), 'zip');
});

test('animation: added characters are typed out, quickly', async () => {
  await page.focus('#anim');
  await page.keyboard.type('Ja');
  const seen = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.getElementById('anim');
        const values = [el.value];
        const t = setInterval(() => {
          if (el.value !== values.at(-1)) values.push(el.value);
          if (el.value === 'January ') {
            clearInterval(t);
            resolve(values);
          }
        }, 5);
      }),
  );
  assert.ok(seen.length >= 4, `typed out in steps: ${JSON.stringify(seen)}`);
  assert.ok(seen.every((v) => 'January '.startsWith(v)));
});

test('animation: typing on never waits for it, or loses anything', async () => {
  await page.focus('#anim');
  await page.keyboard.type('Ja2024'); // no pause after "Ja"
  assert.equal(await value('anim'), 'January 2024');
  await page.focus('#anim-us'); // the "+1 (" prefix is typed out too
  await page.keyboard.type('2125551234');
  assert.equal(await value('anim-us'), '+1 (212) 555-1234');
});

const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

test('data-formaton-prefix="false": nothing on focus, typing and pasting still work', async () => {
  await page.focus('#btc');
  assert.equal(await value('btc'), '');
  await type('q'); // the "bc1" comes with the first character
  assert.equal(await value('btc'), 'bc1q');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(ADDRESS);
  assert.equal(await value('btc'), ADDRESS);
  assert.equal(await page.evaluate(() => window.bindings.btc.complete), true);
});

test('with the prefix on, pasting a whole address does not double it', async () => {
  await page.focus('#btc-on');
  assert.equal(await value('btc-on'), 'bc1');
  await page.keyboard.insertText(ADDRESS);
  assert.equal(await value('btc-on'), ADDRESS);
});

test('attributeOptions() and attachAll() with per-element options', async () => {
  const result = await page.evaluate(async () => {
    const { attachAll, attributeOptions } = await import('/dist/index.js');
    const box = document.createElement('div');
    box.innerHTML = `
      <input id="o1" pattern="\\d{3}-\\d{2}" data-formaton-prefix="false" data-formaton-animate="0"
             data-formaton-auto-advance data-formaton-edit-mode="truncate" data-formaton-placeholder="false">
      <input id="o2" pattern="\\+1 \\d{3}">
      <input id="o3" pattern="\\+1 \\d{3}">`;
    document.body.append(box);
    const parsed = attributeOptions(box.querySelector('#o1'));
    const bindings = attachAll(box, (el) => ({ prefix: el.id === 'o3', animate: false }));
    const ph = box.querySelector('#o1').getAttribute('placeholder');
    box.querySelector('#o2').focus();
    const o2 = box.querySelector('#o2').value;
    box.querySelector('#o3').focus();
    const o3 = box.querySelector('#o3').value;
    for (const b of bindings) b.detach();
    box.remove();
    return { parsed, count: bindings.length, ph, o2, o3 };
  });
  assert.deepEqual(result.parsed, { prefix: false, autoAdvance: true, animate: 0, editMode: 'truncate', placeholder: false });
  assert.equal(result.count, 3);
  assert.equal(result.ph, null);
  assert.equal(result.o2, '');
  assert.equal(result.o3, '+1 ');
});
