// Compares valex with the JS engine's own regex matcher on many strings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../dist/index.js';

const PATTERNS = [
  String.raw`\+1 \([2-90]\d{2}\) \d{3} \d{4}`,
  String.raw`\d{5}([\-]\d{4})?`,
  String.raw`(0[0-9]|1[0-9]|2[0-3])(:[0-5][0-9]){2}`,
  String.raw`[12][0-9]{3}-(0[1-9]|1[012])-(0[1-9]|1[0-9]|2[0-9]|3[01])`,
  String.raw`#?([a-f0-9]{6}|[A-F0-9]{6}|[a-f0-9]{3}|[A-F0-9]{3})`,
  String.raw`(January|June|July) ([1-9]|[12][0-9]|3[01]), (19|20)[0-9][0-9]`,
  String.raw`[a-z0-9\-\.]{1,5}@[a-z0-9\-\.]{1,5}\.(com|co\.uk|co)`,
  String.raw`a*b+c?`,
  String.raw`(ab|a)*b`,
  String.raw`x{2,4}y{0,2}`,
  String.raw`[^0-9]{1,3}`,
  String.raw`^\d+$`,
  String.raw`^a|b$`,
  String.raw`a$|ab`,
  String.raw`(?:a|b)?c`,
  String.raw`.{0,3}`,
  String.raw`[\w.\-]+@[\w\-]+\.\w{2,}`,
  String.raw`\s*\S+`,
  String.raw`colou?r`,
  String.raw`(a|)+b`,
  String.raw`(a*)*b`,
  String.raw`(?<year>\d{2})-(?<n>[A-C])`,
  String.raw`[\u{1F600}-\u{1F64F}]{1,2}x`,
  String.raw`😀|\x41B\u{43}`,
  String.raw`\p{Lu}\p{Ll}{0,3}`,
  String.raw`[\d--[5]]{2}`,
  String.raw`[[a-z]&&[^aeiou]]+`,
  String.raw`[\q{ab|c|}]+d`,
  String.raw`[\-\]\\]\t?`,
  String.raw`[]a|b`,
  String.raw`(a{0}b){1,2}`,
];

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const pattern of PATTERNS) {
  test(`agrees with native RegExp: /${pattern}/`, () => {
    const v = compile(pattern, { mode: 'v' });
    const native = new RegExp(`^(?:${pattern})$`, 'v');
    const random = rng(pattern.length * 7919);

    // Alphabet: characters from random examples plus some noise.
    const examples = [];
    for (let i = 0; i < 40; i++) {
      const e = v.example({ random, length: random() < 0.5 ? 'min' : 'max' });
      if (e !== null) examples.push(e);
    }
    const alphabet = [...new Set([...examples.join(''), ...Array.from(pattern), ...'aZ09 -.,:#@'])];

    const minRaw = v.minValueLength();
    const maxRaw = v.maxValueLength();
    for (const e of examples) {
      assert.ok(native.test(e), `example ${JSON.stringify(e)} should match`);
      // unformat() and format() round-trip, up to optional trailing literals.
      const raw = v.unformat(e);
      assert.ok(raw.length >= minRaw && raw.length <= maxRaw, `raw length of ${JSON.stringify(e)}`);
      const back = v.format(raw);
      assert.ok(back.ok && back.complete && e.startsWith(back.value), `format(${JSON.stringify(raw)}) = ${JSON.stringify(back.value)}, from ${JSON.stringify(e)}`);
      assert.equal(v.unformat(back.value), raw);
      const cps = Array.from(e);
      for (let k = 0; k <= cps.length; k++) {
        const p = cps.slice(0, k).join('');
        assert.ok(v.isPrefix(p), `${JSON.stringify(p)} is a prefix of ${JSON.stringify(e)}`);
        // Everything forced after a prefix must appear in this match too.
        assert.ok(e.startsWith(p + v.forced(p)), `forced after ${JSON.stringify(p)} vs ${JSON.stringify(e)}`);
      }
    }

    const strings = [...examples];
    for (let i = 0; i < 1500; i++) {
      if (examples.length && random() < 0.6) {
        // Mutate a real match.
        const cps = Array.from(examples[Math.floor(random() * examples.length)]);
        const edits = 1 + Math.floor(random() * 3);
        for (let j = 0; j < edits; j++) {
          const at = Math.floor(random() * (cps.length + 1));
          const ch = alphabet[Math.floor(random() * alphabet.length)];
          const op = random();
          if (op < 0.33) cps.splice(at, 0, ch);
          else if (op < 0.66) cps.splice(at, 1);
          else cps.splice(at, 1, ch);
        }
        strings.push(cps.join(''));
      } else {
        const len = Math.floor(random() * 8);
        let s = '';
        for (let j = 0; j < len; j++) s += alphabet[Math.floor(random() * alphabet.length)];
        strings.push(s);
      }
    }

    for (const s of strings) {
      assert.equal(v.test(s), native.test(s), `test(${JSON.stringify(s)})`);
      if (v.isPrefix(s)) {
        // Soundness: a viable prefix really completes into a match.
        const done = v.example({ value: s, raw: false });
        assert.ok(done === null || done.startsWith(v.fix(s).value));
        assert.ok(done !== null && native.test(done), `completion of ${JSON.stringify(s)}: ${JSON.stringify(done)}`);
        const fixed = v.fix(s, { caseFix: false, insertForced: false });
        assert.equal(fixed.value, s);
      }
      // fix() always returns a viable prefix.
      const f = v.fix(s, { drop: true });
      assert.ok(v.isPrefix(f.value), `fix(${JSON.stringify(s)}) = ${JSON.stringify(f.value)}`);
      assert.equal(f.complete, native.test(f.value));
    }

    // Lengths agree with what we observed.
    const lens = strings.filter((s) => native.test(s)).map((s) => s.length);
    const min = v.minLength();
    const max = v.maxLength();
    if (lens.length) {
      assert.ok(min <= Math.min(...lens), 'minLength');
      assert.ok(max >= Math.max(...lens), 'maxLength');
    }
  });
}
