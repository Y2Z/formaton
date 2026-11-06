import { CharSet, MAX_CODE_POINT } from './charset.js';
import { ValexSyntaxError, ValexUnsupportedError } from './errors.js';

/**
 * Regex syntax mode. Browsers compile the `pattern` attribute with the `v`
 * (unicodeSets) flag; older ones used `u`.
 */
export type Mode = 'u' | 'v';

/** Regex AST. Capturing is irrelevant to matching, so groups disappear. */
export type Node =
  | { t: 'set'; set: CharSet }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; options: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: '^' | '$' };

/** Largest repetition count we are willing to unroll. */
export const MAX_REPEAT = 10_000;

const cp = (s: string): number => s.codePointAt(0)!;

export const LINE_TERMINATORS = CharSet.of(0x0a, 0x0d, 0x2028, 0x2029);
export const DIGITS = CharSet.range(0x30, 0x39);
export const WORD = CharSet.fromRanges([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);
export const SPACE = CharSet.fromRanges([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);

const SYNTAX_CHARS = new Set(Array.from('^$\\.*+?()[]{}|/', cp));
const CLASS_SET_RESERVED_PUNCTUATORS = new Set(Array.from('&-!#%,:;<=>@`~', cp));

/** A parsed class: single code points plus multi-code-point strings (`\q{}`). */
interface ClassValue {
  set: CharSet;
  strings: number[][];
}

type Escape =
  | { kind: 'cp'; cp: number }
  | { kind: 'set'; set: CharSet }
  | { kind: 'class'; value: ClassValue };

const set = (s: CharSet): Node => ({ t: 'set', set: s });

const propertyCache = new Map<string, CharSet>();

/**
 * Builds the set for `\p{...}` by asking the JS engine, so we need no Unicode
 * tables of our own. Done once per property, lazily.
 */
function propertySet(body: string, pattern: string): CharSet {
  const cached = propertyCache.get(body);
  if (cached) return cached;
  let re: RegExp;
  try {
    re = new RegExp(`^\\p{${body}}$`, 'u');
  } catch {
    // Either invalid, or a v-only "property of strings" such as \p{RGI_Emoji}.
    throw new ValexUnsupportedError(`Property escape \\p{${body}} is not supported (/${pattern}/)`);
  }
  const ranges: Array<[number, number]> = [];
  let runStart = -1;
  for (let c = 0; c <= MAX_CODE_POINT + 1; c++) {
    if (c === 0xd800) {
      // Skip surrogates: close any open run first.
      if (runStart >= 0) ranges.push([runStart, 0xd7ff]);
      runStart = -1;
      c = 0xe000;
    }
    const hit = c <= MAX_CODE_POINT && re.test(String.fromCodePoint(c));
    if (hit) {
      if (runStart < 0) runStart = c;
    } else if (runStart >= 0) {
      ranges.push([runStart, c - 1]);
      runStart = -1;
    }
  }
  const result = CharSet.fromRanges(ranges);
  propertyCache.set(body, result);
  return result;
}

export function parse(pattern: string, mode: Mode): Node {
  return new Parser(pattern, mode).parsePattern();
}

class Parser {
  private readonly cps: number[];
  private pos = 0;

  constructor(
    private readonly src: string,
    private readonly mode: Mode,
  ) {
    this.cps = Array.from(src, cp);
  }

  parsePattern(): Node {
    const node = this.parseDisjunction();
    if (!this.atEnd()) this.fail(`Unexpected '${String.fromCodePoint(this.cps[this.pos])}'`);
    return node;
  }

  // ---- helpers ------------------------------------------------------------

  private atEnd(): boolean {
    return this.pos >= this.cps.length;
  }

  private is(ch: string, offset = 0): boolean {
    return this.cps[this.pos + offset] === cp(ch);
  }

  private eat(ch: string): boolean {
    if (this.is(ch)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) this.fail(`Expected '${ch}'`);
  }

  private next(): number {
    if (this.atEnd()) this.fail('Unexpected end of pattern');
    return this.cps[this.pos++];
  }

  private rest(n = 64): string {
    return String.fromCodePoint(...this.cps.slice(this.pos, this.pos + n));
  }

  private fail(message: string): never {
    throw new ValexSyntaxError(`${message} at position ${this.pos} in /${this.src}/`);
  }

  private unsupported(what: string): never {
    throw new ValexUnsupportedError(`${what} is not supported (/${this.src}/)`);
  }

  // ---- structure ------------------------------------------------------------

  private parseDisjunction(): Node {
    const options = [this.parseAlternative()];
    while (this.eat('|')) options.push(this.parseAlternative());
    return options.length === 1 ? options[0] : { t: 'alt', options };
  }

  private parseAlternative(): Node {
    const items: Node[] = [];
    while (!this.atEnd() && !this.is('|') && !this.is(')')) items.push(this.parseTerm());
    return items.length === 1 ? items[0] : { t: 'seq', items };
  }

  private parseTerm(): Node {
    if (this.eat('^')) return { t: 'assert', kind: '^' };
    if (this.eat('$')) return { t: 'assert', kind: '$' };
    if (this.is('\\') && (this.is('b', 1) || this.is('B', 1))) {
      this.unsupported('Word boundary assertion (\\b, \\B)');
    }
    if (
      this.is('(') &&
      this.is('?', 1) &&
      (this.is('=', 2) || this.is('!', 2) || (this.is('<', 2) && (this.is('=', 3) || this.is('!', 3))))
    ) {
      this.unsupported('Lookaround assertion');
    }
    return this.parseQuantifier(this.parseAtom());
  }

  private parseQuantifier(atom: Node): Node {
    let min: number;
    let max: number;
    if (this.eat('*')) {
      min = 0;
      max = Infinity;
    } else if (this.eat('+')) {
      min = 1;
      max = Infinity;
    } else if (this.eat('?')) {
      min = 0;
      max = 1;
    } else if (this.is('{')) {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.rest());
      if (!m) this.fail("Lone quantifier bracket '{'");
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      if (max < min) this.fail('Numbers out of order in {} quantifier');
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        this.unsupported(`Repetition count above ${MAX_REPEAT}`);
      }
      this.pos += m[0].length;
    } else {
      return atom;
    }
    this.eat('?'); // lazy modifier: irrelevant for full-string matching
    if (atom.t === 'assert') this.fail('Nothing to repeat');
    return { t: 'rep', node: atom, min, max };
  }

  private parseAtom(): Node {
    const c = this.next();
    switch (c) {
      case cp('.'):
        return set(LINE_TERMINATORS.complement());
      case cp('('): {
        if (this.eat('?')) {
          if (this.eat(':')) {
            // non-capturing
          } else if (this.eat('<')) {
            while (!this.eat('>')) this.next(); // group name
          } else {
            this.unsupported('Modifier group (?flags:...)');
          }
        }
        const inner = this.parseDisjunction();
        this.expect(')');
        return inner;
      }
      case cp('['):
        return this.parseClass();
      case cp('\\'):
        return this.parseAtomEscape();
      case cp('*'):
      case cp('+'):
      case cp('?'):
      case cp('{'):
        this.pos--;
        return this.fail('Nothing to repeat');
      case cp(')'):
      case cp(']'):
      case cp('}'):
        this.pos--;
        return this.fail(`Lone '${String.fromCodePoint(c)}'`);
      default:
        return set(CharSet.of(c));
    }
  }

  private parseAtomEscape(): Node {
    const c = this.cps[this.pos];
    if (c >= cp('1') && c <= cp('9')) this.unsupported('Backreference');
    if (c === cp('k')) this.unsupported('Named backreference');
    const e = this.parseEscape(false);
    if (e.kind === 'cp') return set(CharSet.of(e.cp));
    if (e.kind === 'set') return set(e.set);
    return this.fail('Invalid escape');
  }

  /** Parses the part after a backslash. */
  private parseEscape(inClass: boolean): Escape {
    const c = this.next();
    const ch = String.fromCodePoint(c);
    switch (ch) {
      case 'd':
        return { kind: 'set', set: DIGITS };
      case 'D':
        return { kind: 'set', set: DIGITS.complement() };
      case 'w':
        return { kind: 'set', set: WORD };
      case 'W':
        return { kind: 'set', set: WORD.complement() };
      case 's':
        return { kind: 'set', set: SPACE };
      case 'S':
        return { kind: 'set', set: SPACE.complement() };
      case 'p':
      case 'P': {
        this.expect('{');
        let body = '';
        while (!this.eat('}')) body += String.fromCodePoint(this.next());
        const s = propertySet(body, this.src);
        return { kind: 'set', set: ch === 'P' ? s.complement() : s };
      }
      case 't':
        return { kind: 'cp', cp: 0x09 };
      case 'n':
        return { kind: 'cp', cp: 0x0a };
      case 'v':
        return { kind: 'cp', cp: 0x0b };
      case 'f':
        return { kind: 'cp', cp: 0x0c };
      case 'r':
        return { kind: 'cp', cp: 0x0d };
      case '0':
        if (this.cps[this.pos] >= cp('0') && this.cps[this.pos] <= cp('9')) this.fail('Invalid decimal escape');
        return { kind: 'cp', cp: 0 };
      case 'b':
        if (inClass) return { kind: 'cp', cp: 0x08 };
        break;
      case '-':
        if (inClass) return { kind: 'cp', cp: c };
        break;
      case 'c': {
        const l = this.next();
        if (!((l >= 0x41 && l <= 0x5a) || (l >= 0x61 && l <= 0x7a))) this.fail('Invalid control escape');
        return { kind: 'cp', cp: l % 32 };
      }
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(this.rest(2));
        if (!m) this.fail('Invalid \\x escape');
        this.pos += 2;
        return { kind: 'cp', cp: parseInt(m[0], 16) };
      }
      case 'u':
        return { kind: 'cp', cp: this.parseUnicodeEscape() };
      case 'q':
        if (inClass && this.mode === 'v') return { kind: 'class', value: this.parseClassStrings() };
        break;
    }
    if (SYNTAX_CHARS.has(c)) return { kind: 'cp', cp: c };
    if (inClass && this.mode === 'v' && CLASS_SET_RESERVED_PUNCTUATORS.has(c)) return { kind: 'cp', cp: c };
    this.pos--;
    return this.fail(`Invalid escape '\\${ch}'`);
  }

  /** After `\u`: `{X...}` or `XXXX`, joining surrogate pairs. */
  private parseUnicodeEscape(): number {
    if (this.eat('{')) {
      const m = /^([0-9a-fA-F]+)\}/.exec(this.rest(16));
      if (!m) this.fail('Invalid \\u{} escape');
      const value = parseInt(m[1], 16);
      if (value > MAX_CODE_POINT) this.fail('\\u{} escape out of range');
      this.pos += m[0].length;
      return value;
    }
    const m = /^[0-9a-fA-F]{4}/.exec(this.rest(4));
    if (!m) this.fail('Invalid \\u escape');
    this.pos += 4;
    const lead = parseInt(m[0], 16);
    if (lead >= 0xd800 && lead <= 0xdbff) {
      const t = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(this.rest(6));
      if (t) {
        this.pos += 6;
        return (lead - 0xd800) * 0x400 + (parseInt(t[1], 16) - 0xdc00) + 0x10000;
      }
    }
    return lead;
  }

  // ---- character classes ------------------------------------------------------

  private parseClass(): Node {
    const value = this.mode === 'v' ? this.parseClassV() : this.parseClassU();
    if (value.strings.length === 0) return set(value.set);
    const options: Node[] = [];
    if (!value.set.isEmpty) options.push(set(value.set));
    for (const s of value.strings) options.push({ t: 'seq', items: s.map((c) => set(CharSet.of(c))) });
    return options.length === 1 ? options[0] : { t: 'alt', options };
  }

  /** Classic `u`-mode class, after the opening `[`. */
  private parseClassU(): ClassValue {
    const negate = this.eat('^');
    let acc = CharSet.EMPTY;
    const atom = (): Escape => (this.eat('\\') ? this.parseEscape(true) : { kind: 'cp', cp: this.next() });
    while (!this.is(']')) {
      if (this.atEnd()) this.fail('Unterminated character class');
      const a = atom();
      if (a.kind === 'cp' && this.is('-') && !this.is(']', 1) && this.pos + 1 < this.cps.length) {
        this.pos++;
        const b = atom();
        if (b.kind !== 'cp' || b.cp < a.cp) this.fail('Invalid character class range');
        acc = acc.union(CharSet.range(a.cp, b.cp));
      } else if (a.kind === 'cp') {
        acc = acc.union(CharSet.of(a.cp));
      } else if (a.kind === 'set') {
        acc = acc.union(a.set);
      } else {
        this.fail('Invalid escape in class');
      }
    }
    this.pos++;
    return { set: negate ? acc.complement() : acc, strings: [] };
  }

  /** `v`-mode class (nesting, `&&`, `--`, `\q{}`), after the opening `[`. */
  private parseClassV(): ClassValue {
    const negate = this.eat('^');
    let result: ClassValue;
    if (this.is(']')) {
      result = { set: CharSet.EMPTY, strings: [] };
    } else {
      const first = this.parseClassOperandV(true);
      if (this.is('&') && this.is('&', 1)) {
        result = first;
        while (this.is('&') && this.is('&', 1)) {
          this.pos += 2;
          result = this.combine(result, this.parseClassOperandV(false), 'intersection');
        }
      } else if (this.is('-') && this.is('-', 1)) {
        result = first;
        while (this.is('-') && this.is('-', 1)) {
          this.pos += 2;
          result = this.combine(result, this.parseClassOperandV(false), 'subtraction');
        }
      } else {
        result = first;
        while (!this.is(']')) {
          if (this.atEnd()) this.fail('Unterminated character class');
          const op = this.parseClassOperandV(true);
          result = { set: result.set.union(op.set), strings: [...result.strings, ...op.strings] };
        }
      }
    }
    this.expect(']');
    if (negate) {
      if (result.strings.length) this.fail('Negated character class may contain strings');
      result = { set: result.set.complement(), strings: [] };
    }
    return result;
  }

  private combine(a: ClassValue, b: ClassValue, op: 'intersection' | 'subtraction'): ClassValue {
    if (a.strings.length || b.strings.length) this.unsupported(`Strings in class ${op}`);
    return { set: op === 'intersection' ? a.set.intersect(b.set) : a.set.minus(b.set), strings: [] };
  }

  private parseClassOperandV(allowRange: boolean): ClassValue {
    if (this.eat('[')) return this.parseClassV();
    const atom = (): Escape => (this.eat('\\') ? this.parseEscape(true) : { kind: 'cp', cp: this.next() });
    const a = atom();
    if (a.kind === 'cp') {
      if (allowRange && this.is('-') && !this.is('-', 1)) {
        this.pos++;
        const b = atom();
        if (b.kind !== 'cp' || b.cp < a.cp) this.fail('Invalid character class range');
        return { set: CharSet.range(a.cp, b.cp), strings: [] };
      }
      return { set: CharSet.of(a.cp), strings: [] };
    }
    if (a.kind === 'set') return { set: a.set, strings: [] };
    return a.value;
  }

  /** `\q{abc|d|}` after the `q`. */
  private parseClassStrings(): ClassValue {
    this.expect('{');
    let single = CharSet.EMPTY;
    const strings: number[][] = [];
    let current: number[] = [];
    const flush = () => {
      if (current.length === 1) single = single.union(CharSet.of(current[0]));
      else strings.push(current);
      current = [];
    };
    for (;;) {
      if (this.eat('}')) break;
      if (this.eat('|')) {
        flush();
        continue;
      }
      if (this.eat('\\')) {
        const e = this.parseEscape(true);
        if (e.kind !== 'cp') this.fail('Invalid escape in \\q{}');
        current.push(e.cp);
      } else {
        current.push(this.next());
      }
    }
    flush();
    return { set: single, strings };
  }
}
