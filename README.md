# valex

Placeholders and typing help derived from the HTML `pattern` attribute.

You write one regular expression in `pattern="…"`. The browser already uses it
to validate the field. valex reads the same pattern and works out what the user
can type next. It can then:

- **insert characters the pattern forces**: `(212` becomes `(212) ` for
  `\(\d{3}\) \d{3}-\d{4}`
- **repair pasted or prefilled values**: `2125551234` becomes `(212) 555-1234`
- **fix letter case** when only the other case fits: `abcd` becomes `ABCD` for
  `[A-Z]{4}`
- **erase separators together with the character before them** on backspace
- **generate placeholders**: `(___) ___-____`, or a sample value such as
  `(000) 000-0000`, including ghost text after a partial value: `(212) ___-____`
- **compute min/max length**, for `maxlength`

This is the successor to `valex.js` and `jquery-valium` (2014). Those listed
every matching string, which could not scale. This version compiles the pattern
into an automaton, so `[a-z0-9.-]{1,64}@…` is as cheap as `\d{4}`.

> Status: the core engine (this package) is a working prototype. The DOM
> binding that attaches it to `<input>` and `<textarea>` elements is next.

## Usage

```js
import { compile } from 'valex';

const phone = compile(String.raw`\(\d{3}\) \d{3}-\d{4}`);

phone.prefix();                      // "("
phone.forced('(212');                // ") "
phone.fix('2125551234').value;       // "(212) 555-1234"
phone.trimForced('(212) ');          // "(212"
phone.example({ mask: '_' });        // "(___) ___-____"
phone.example({ prefix: '(212', mask: '_' }); // "(212) ___-____"
phone.test('(212) 555-1234');        // true
phone.maxLength();                   // 14
```

## API

`compile(pattern, { mode })` returns a `Valex`. `mode` is `'v'`, `'u'` or
`'auto'` (default). Browsers compile `pattern` with the `v` flag, and `auto`
does the same wherever the JS engine supports it. An invalid pattern throws
`ValexSyntaxError`. A valid pattern that an automaton cannot model throws
`ValexUnsupportedError`; leave such fields unassisted.

All matching is full-string, as in the browser: `^(?:pattern)$`.

| Method | Returns |
| --- | --- |
| `test(value)` | `true` if `value` matches |
| `isPrefix(value)` | `true` if `value` can still be completed into a match |
| `allowedNext(value)` | `CharSet` of possible next characters, or `null` at a dead end |
| `forced(value)` | the characters that must come next (stops once `value` is a complete match) |
| `prefix()` | `forced('')`: what every match starts with |
| `fix(value, { caseFix, insertForced, drop })` | `{ value, ok, complete }`; `value` is always a viable prefix |
| `trimForced(value)` | `value` without trailing characters the pattern would insert by itself |
| `example({ prefix, length, mask, random })` | a matching string, or `null` if none exists |
| `minLength()`, `maxLength()` | lengths in UTF-16 code units (as `maxlength` counts them); `Infinity` if unbounded |

`fix()` options all default to on, except `drop`:

- `caseFix` flips a letter's case if only the other case is allowed.
- `insertForced` adds separators the user skipped.
- `drop` skips characters that cannot be placed. Without it, `fix()` stops at
  the first such character and reports `ok: false`.

`example()` options:

- `length: 'max'` produces the longest match. It falls back to the shortest
  when the pattern is unbounded.
- `mask` replaces every character the user would have to choose.
- `random` supplies a random-number function for varied sample values.

## Supported syntax

Everything an automaton can model:

- literals and all escapes (`\d \w \s`, `\x41`, `A`, `\u{1F600}`, `\cJ`, …)
- `.`, classes and negated classes
- `v`-mode nested classes, `&&`, `--` and `\q{…}`
- `\p{…}` / `\P{…}`: Unicode properties, resolved through the JS engine, so no
  tables are bundled
- groups, named groups, alternation
- every quantifier (counts up to 10,000)
- `^` and `$`

Not supported: backreferences, lookahead and lookbehind, `\b` / `\B`, modifier
groups `(?i:…)`, and properties of strings (`\p{RGI_Emoji}`).

## Development

```sh
npm test   # builds with tsc, then runs node:test
```

The tests include every pattern from the old `jquery-valium` test page. The bugs
that page listed are now covered by test cases. A differential suite checks
`test()`, `isPrefix()`, `forced()`, `fix()` and the lengths against the JS
engine's own regex matcher on thousands of generated strings.

## History

`valex.js` was based on Alix Axel's [genex.js](https://github.com/alixaxel/genex.js)
and embedded Roly Fentanes' [ret.js](https://github.com/fent/ret.js) tokenizer.
This rewrite shares no code with either.

## License

MIT
