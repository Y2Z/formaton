import { CharSet, MAX_CODE_POINT } from './charset.js';
import { Dfa, type DState, type Transition } from './dfa.js';
import { ValexSyntaxError, ValexUnsupportedError } from './errors.js';
import { buildNfa, type Nfa } from './nfa.js';
import { parse, SPACE, type Mode } from './parser.js';
import { longestPath, shortestPath, type Succ } from './paths.js';

export { CharSet, ValexSyntaxError, ValexUnsupportedError };
export type { Mode };

export interface CompileOptions {
  /**
   * Regex syntax to follow. `auto` (default) uses `v` where the JS engine
   * supports it, like current browsers do for the `pattern` attribute.
   */
  mode?: Mode | 'auto';
}

export interface FixOptions {
  /** Flip the case of a rejected letter if that makes it fit. Default true. */
  caseFix?: boolean;
  /** Insert forced characters (separators) the user skipped. Default true. */
  insertForced?: boolean;
  /** Skip characters that cannot be placed instead of stopping. Default false. */
  drop?: boolean;
}

export interface FixResult {
  /** The corrected value: always a viable prefix of some match. */
  value: string;
  /** True if every input character was placed (possibly case-flipped). */
  ok: boolean;
  /** True if `value` fully matches the pattern. */
  complete: boolean;
  /**
   * Input that was not used: everything from the first character that did
   * not fit, or with `drop` the characters that were skipped.
   */
  rejected: string;
}

export interface ExampleOptions {
  /**
   * Complete this value instead of starting from scratch. It goes through
   * `fix()` like typed or pasted input, so "212" and "(212" both give
   * "(212) ___-____"; from the first character that does not fit, the rest
   * is rejected.
   */
  value?: string;
  /** Shortest (default) or longest completion. Unbounded patterns fall back to shortest. */
  length?: 'min' | 'max';
  /**
   * Replace every character that is not forced by the pattern with this
   * string, e.g. "_" gives "(___) ___-____".
   */
  mask?: string;
  /** Source of randomness for picking characters; omit for deterministic output. */
  random?: () => number;
}

export interface MaskOptions extends Pick<ExampleOptions, 'length'> {
  /** Stand-in for every character the user has yet to choose. Default "_". */
  char?: string;
}

/** Does the JS engine understand the `v` flag? */
const NATIVE_V = (() => {
  try {
    new RegExp('', 'v');
    return true;
  } catch {
    return false;
  }
})();

/** Order in which character classes are preferred when picking an example character. */
const PREFERRED: CharSet[] = [
  CharSet.fromRanges([
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ]),
  CharSet.range(0x21, 0x7e),
  CharSet.of(0x20),
  CharSet.fromRanges([
    [0xa1, 0xd7ff],
    [0xe000, MAX_CODE_POINT],
  ]).minus(SPACE),
];

/** Limits that keep pathological patterns from freezing a page. */
const MAX_EXAMPLE_STATES = 20_000;
const MAX_FORCED = 10_000;
const MAX_EXPLORE_STATES = 50_000;

function pickChar(set: CharSet, random?: () => number): number {
  for (const p of PREFERRED) {
    const s = set.intersect(p);
    if (!s.isEmpty) return random ? s.nth(Math.floor(random() * s.size))! : s.first()!;
  }
  return set.first()!;
}

const units = (cp: number) => (cp > 0xffff ? 2 : 1);

/** Compiles an HTML `pattern` attribute value. */
export function compile(pattern: string, options: CompileOptions = {}): Valex {
  return new Valex(pattern, options);
}

/**
 * A compiled pattern. Matching follows HTML semantics: the whole value must
 * match, as if the pattern were `^(?:pattern)$`.
 */
export class Valex {
  readonly pattern: string;
  readonly mode: Mode;
  private readonly nfa: Nfa;
  private readonly dfa: Dfa;
  private explored?: DState[];
  private chars?: CharSet;

  constructor(pattern: string, options: CompileOptions = {}) {
    const requested = options.mode ?? 'auto';
    const mode: Mode = requested === 'auto' ? (NATIVE_V ? 'v' : 'u') : requested;
    if (mode === 'u' || NATIVE_V) {
      try {
        new RegExp(pattern, mode);
      } catch (e) {
        throw new ValexSyntaxError(`Invalid pattern /${pattern}/: ${(e as Error).message}`);
      }
    }
    this.pattern = pattern;
    this.mode = mode;
    this.nfa = buildNfa(parse(pattern, mode));
    this.dfa = new Dfa(this.nfa);
  }

  // ---- matching -------------------------------------------------------------

  /** State after reading `value`, or null if `value` cannot lead to a match. */
  private walk(value: string): DState | null {
    let d = this.dfa.start;
    for (const ch of value) {
      if (!d) return null;
      d = this.dfa.step(d, ch.codePointAt(0)!);
    }
    return d;
  }

  /** Full match, like the browser's pattern validation. */
  test(value: string): boolean {
    return this.walk(value)?.accept ?? false;
  }

  /** Can `value` still be extended into a match? */
  isPrefix(value: string): boolean {
    return this.walk(value) !== null;
  }

  /** Characters that may come next, or null if `value` is already a dead end. */
  allowedNext(value: string): CharSet | null {
    const d = this.walk(value);
    return d ? this.dfa.allowed(d) : null;
  }

  /**
   * Characters the pattern forces after `value`: the run of positions where
   * exactly one character is possible and `value` is not yet complete.
   * For `\(\d{3}\) \d{3}-\d{4}` and "(212" this is ") ".
   */
  forced(value: string): string {
    const d = this.walk(value);
    return d ? this.forcedRun(d).chars.join('') : '';
  }

  /** Characters every match starts with ("+1 (" for a US phone pattern). */
  prefix(): string {
    return this.forced('');
  }

  /** Whether the pattern leaves exactly one choice for the next character. */
  private isForced(d: DState): boolean {
    return this.dfa.allowed(d).single() !== undefined;
  }

  /** The run of single-choice characters after `d`, up to a complete match. */
  private forcedRun(d: DState): { chars: string[]; states: DState[] } {
    const chars: string[] = [];
    const states: DState[] = [];
    const seen = new Set<DState>([d]);
    while (!d.accept && chars.length < MAX_FORCED) {
      const t = this.dfa.transitions(d);
      if (t.length !== 1) break;
      const only = t[0].set.single();
      if (only === undefined || seen.has(t[0].next)) break;
      chars.push(String.fromCodePoint(only));
      d = t[0].next;
      seen.add(d);
      states.push(d);
    }
    return { chars, states };
  }

  /**
   * The characters the user actually chose, without the ones the pattern
   * dictates: "(212) 555-1234" gives "2125551234". The inverse of
   * `format()`. Characters after the point where `value` stops fitting the
   * pattern are kept as they are. With `from`, only characters from that
   * UTF-16 index on are returned (the rest still decides what is forced).
   */
  unformat(value: string, from = 0): string {
    let d = this.dfa.start;
    let out = '';
    let at = 0;
    for (const ch of value) {
      const keep = at >= from;
      at += ch.length;
      if (!d) {
        if (keep) out += ch;
        continue;
      }
      if (keep && !this.isForced(d)) out += ch;
      d = this.dfa.step(d, ch.codePointAt(0)!);
    }
    return out;
  }

  /**
   * For each code point of `value`: would valex have inserted it by itself?
   * True for separators `forced()` adds (the ")" and " " of "(212) "), false
   * for what the user chose and for optional characters such as the "-" of
   * a ZIP+4 code, which only the user can decide to add. Characters after the
   * point where `value` stops fitting are false.
   */
  autoChars(value: string): boolean[] {
    const out: boolean[] = [];
    let d = this.dfa.start;
    for (const ch of value) {
      out.push(!!d && !d.accept && this.isForced(d));
      d = d ? this.dfa.step(d, ch.codePointAt(0)!) : null;
    }
    return out;
  }

  /**
   * Builds the formatted value from raw characters (the output of
   * `unformat()`): every single-choice character is inserted, every other
   * position takes the next raw character. "2125551234" gives
   * "(212) 555-1234", "212" gives "(212) ". Strict: a raw character that does
   * not fit stops it with `ok: false`; for forgiving input handling (typing,
   * pasting) use `fix()`. An optional single-choice character at the very end
   * (the "-" of `\d{3}-?`) cannot be told apart from its absence, so the
   * shorter match is produced.
   */
  format(raw: string): FixResult {
    const cps = Array.from(raw);
    let d = this.dfa.start;
    if (!d) return { value: '', ok: raw === '', complete: false, rejected: raw };
    let out = '';
    let i = 0;
    let inserted = 0;
    while (i < cps.length) {
      const only = this.dfa.allowed(d).single();
      if (only !== undefined) {
        if (++inserted > MAX_FORCED) break;
        out += String.fromCodePoint(only);
        d = this.dfa.step(d, only)!;
        continue;
      }
      const next = this.dfa.step(d, cps[i].codePointAt(0)!);
      if (!next) break;
      out += cps[i++];
      d = next;
      inserted = 0;
    }
    if (i === cps.length) {
      // Trailing separators, as typing would have produced them.
      const run = this.forcedRun(d);
      out += run.chars.join('');
      if (run.states.length) d = run.states[run.states.length - 1];
    }
    return { value: out, ok: i === cps.length, complete: d.accept, rejected: cps.slice(i).join('') };
  }

  /**
   * Corrects typed or pasted text, formatted or raw: flips letter case where
   * only the other case fits, and inserts the characters the pattern dictates.
   * "2125551234", "(212)555-1234" and "(212) 555-1234" all give
   * "(212) 555-1234" for `\(\d{3}\) \d{3}-\d{4}`.
   *
   * Every reading of the input is considered: each character is either
   * typed as is, typed with its case flipped, or (with `drop`) discarded, and
   * single-choice characters may be inserted before it. The winner keeps the
   * most input, then drops the fewest characters, then is the input exactly
   * as typed if that fits, then forms a complete match if any reading does,
   * then changes the least. So for `\+1 \d{10}`,
   * "12125551234" is read as country code plus number, while "1212555123" is
   * read as a raw number starting with 1. Nothing is appended after the last
   * input character; `forced()` gives that.
   */
  fix(value: string, options: FixOptions = {}): FixResult {
    const { caseFix = true, insertForced = true, drop = false } = options;
    const start = this.dfa.start;
    if (!start) return { value: '', ok: value === '', complete: false, rejected: value };

    interface Reading {
      d: DState;
      /** Last move was an insertion: may not end here or drop next. */
      dangling: boolean;
      dropped: number;
      /** Insertions plus case flips. */
      cost: number;
      prev: Reading | null;
      emit: string;
      /** Input character discarded by this move (with `drop`). */
      skipped?: string;
    }
    const better = (a: Reading, b: Reading) => a.dropped < b.dropped || (a.dropped === b.dropped && a.cost < b.cost);
    const relax = (layer: Map<string, Reading>, r: Reading): boolean => {
      const key = r.d.id + (r.dangling ? '*' : '');
      const old = layer.get(key);
      if (old && !better(r, old)) return false;
      layer.set(key, r);
      return true;
    };
    const insertions = (layer: Map<string, Reading>) => {
      const work = [...layer.values()];
      while (work.length) {
        const r = work.pop()!;
        const only = this.dfa.allowed(r.d).single();
        if (only === undefined) continue;
        const next: Reading = {
          d: this.dfa.step(r.d, only)!,
          dangling: true,
          dropped: r.dropped,
          cost: r.cost + 1,
          prev: r,
          emit: String.fromCodePoint(only),
        };
        if (relax(layer, next)) work.push(next);
      }
    };

    const cps = Array.from(value);
    let layer = new Map<string, Reading>();
    relax(layer, { d: start, dangling: false, dropped: 0, cost: 0, prev: null, emit: '' });
    let consumed = 0;
    for (;;) {
      if (insertForced && consumed < cps.length) insertions(layer);
      if (consumed === cps.length) break;
      const ch = cps[consumed];
      const variants: Array<[string, number]> = [[ch, 0]];
      if (caseFix) {
        for (const alt of [ch.toLowerCase(), ch.toUpperCase()]) {
          if (alt !== ch && Array.from(alt).length === 1 && !variants.some(([v]) => v === alt)) variants.push([alt, 1]);
        }
      }
      const next = new Map<string, Reading>();
      for (const r of layer.values()) {
        for (const [c, w] of variants) {
          const d = this.dfa.step(r.d, c.codePointAt(0)!);
          if (d) relax(next, { d, dangling: false, dropped: r.dropped, cost: r.cost + w, prev: r, emit: c });
        }
        if (drop && !r.dangling) {
          relax(next, { d: r.d, dangling: false, dropped: r.dropped + 1, cost: r.cost, prev: r, emit: '', skipped: ch });
        }
      }
      if (!next.size) break;
      layer = next;
      consumed++;
    }

    // Fewest dropped characters; then input that fits exactly as typed;
    // then a complete match; then the fewest changes.
    const rank = (r: Reading) => r.dropped * 4e6 + (r.cost === 0 ? 0 : 2e6) + (r.d.accept ? 0 : 1e6) + r.cost;
    let best: Reading | null = null;
    for (const r of layer.values()) {
      if (r.dangling) continue;
      if (!best || rank(r) < rank(best)) best = r;
    }
    const parts: string[] = [];
    const skipped: string[] = [];
    for (let r: Reading | null = best!; r; r = r.prev) {
      parts.push(r.emit);
      if (r.skipped !== undefined) skipped.push(r.skipped);
    }
    return {
      value: parts.reverse().join(''),
      ok: consumed === cps.length && best!.dropped === 0,
      complete: best!.d.accept,
      rejected: skipped.reverse().join('') + cps.slice(consumed).join(''),
    };
  }

  /**
   * Removes trailing characters the pattern would have inserted by itself,
   * so backspacing "(212) " leaves "(212" rather than getting stuck.
   * Returns `value` unchanged if it is not a viable prefix.
   */
  trimForced(value: string): string {
    const cps = Array.from(value);
    const trail: Array<DState | null> = [this.dfa.start];
    for (const ch of cps) {
      const prev = trail[trail.length - 1];
      trail.push(prev ? this.dfa.step(prev, ch.codePointAt(0)!) : null);
    }
    if (trail.some((d) => d === null)) return value;
    let k = cps.length;
    while (k > 0) {
      const before = trail[k - 1]!;
      if (before.accept || this.dfa.allowed(before).single() === undefined) break;
      k--;
    }
    return cps.slice(0, k).join('');
  }

  /** Every character that can appear anywhere in a match. */
  alphabet(): CharSet {
    if (this.chars) return this.chars;
    const { states, liveN } = this.nfa;
    let acc = CharSet.EMPTY;
    states.forEach((st, i) => {
      if (!liveN[i]) return;
      for (const { set, to } of st.chars) if (liveN[to]) acc = acc.union(set);
    });
    this.chars = acc;
    return acc;
  }

  // ---- generation ------------------------------------------------------------

  /**
   * A matching string, for placeholders. With `mask: "_"` the phone pattern
   * gives "(___) ___-____"; with `value: "212"` as well it gives
   * "(212) ___-____". Returns null if no match is reachable.
   */
  example(options: ExampleOptions = {}): string | null {
    let start = '';
    if (options.value !== undefined && options.value !== '') {
      start = this.fix(options.value).value;
    }
    const from = this.walk(start);
    if (!from) return null;
    const path = (options.length === 'max' ? this.longestPath(from) : null) ?? this.shortestPath(from);
    if (!path) return null;
    let out = start;
    // In a mask, a forced letter or digit right after a chosen one depends on
    // that choice (the "9" of "19" in (19|20)), so it is masked too. Fixed
    // ones at the start of a part stay: "+1 (", "DE", "0x".
    let afterFree = false;
    for (const { state, t } of path) {
      const free = this.dfa.allowed(state).single() === undefined;
      const ch = String.fromCodePoint(pickChar(t.set, options.random));
      const word = /[\p{L}\p{N}]/u.test(ch);
      if (options.mask !== undefined && (free || (afterFree && word))) {
        out += options.mask;
        afterFree = true;
      } else {
        out += ch;
        if (!word) afterFree = false;
      }
    }
    return out;
  }

  /**
   * Shorthand for a masked example: `mask("212")` gives "(212) ___-____".
   * `value` may be formatted or raw, like anything a user types or pastes.
   */
  mask(value = '', options: MaskOptions = {}): string | null {
    const { char = '_', ...rest } = options;
    return this.example({ ...rest, value, mask: char });
  }

  private shortestPath(from: DState): Array<{ state: DState; t: Transition }> | null {
    const prev = new Map<DState, { state: DState; t: Transition } | null>([[from, null]]);
    let queue = [from];
    let found: DState | null = from.accept ? from : null;
    while (!found && queue.length && prev.size < MAX_EXAMPLE_STATES) {
      const nextQueue: DState[] = [];
      for (const d of queue) {
        for (const t of this.dfa.transitions(d)) {
          if (prev.has(t.next)) continue;
          prev.set(t.next, { state: d, t });
          if (t.next.accept) {
            found = t.next;
            break;
          }
          nextQueue.push(t.next);
        }
        if (found) break;
      }
      queue = nextQueue;
    }
    if (!found) return null;
    const path: Array<{ state: DState; t: Transition }> = [];
    for (let step = prev.get(found); step; step = prev.get(step.state)) path.unshift(step);
    return path;
  }

  /** Longest path to acceptance, or null if unbounded or too large to explore. */
  private longestPath(from: DState): Array<{ state: DState; t: Transition }> | null {
    const best = new Map<DState, { len: number; t: Transition | null }>();
    const onStack = new Set<DState>();
    let aborted = false;

    const visit = (d: DState): number => {
      const known = best.get(d);
      if (known) return known.len;
      if (onStack.has(d) || best.size + onStack.size > MAX_EXAMPLE_STATES) {
        aborted = true;
        return -Infinity;
      }
      onStack.add(d);
      let len = d.accept ? 0 : -Infinity;
      let choice: Transition | null = null;
      for (const t of this.dfa.transitions(d)) {
        const l = 1 + visit(t.next);
        if (aborted) break;
        if (l > len) {
          len = l;
          choice = t;
        }
      }
      onStack.delete(d);
      best.set(d, { len, t: choice });
      return len;
    };

    visit(from);
    if (aborted) return null;
    const path: Array<{ state: DState; t: Transition }> = [];
    for (let d = from, b = best.get(d); b?.t; d = b.t.next, b = best.get(d)) path.push({ state: d, t: b.t });
    return path;
  }

  // ---- lengths (UTF-16 code units, like `maxlength` and `value.length`) ------

  private nfaSucc(min: boolean): Succ {
    const { states, liveN } = this.nfa;
    return (v) => {
      const st = states[v];
      const out: Array<[number, number]> = [];
      for (const t of st.eps) if (liveN[t]) out.push([t, 0]);
      for (const t of st.bol) if (liveN[t]) out.push([t, 0]);
      for (const { set, to } of st.chars) {
        if (liveN[to]) out.push([to, min ? (set.hasBmp ? 1 : 2) : set.hasAstral ? 2 : 1]);
      }
      return out;
    };
  }

  private nfaFinal = (v: number): boolean =>
    v === this.nfa.accept || this.nfa.states[v].eol.some((t) => this.nfa.liveE[t]);

  /** Length of the shortest match, or null if nothing matches. */
  minLength(): number | null {
    const { states, start, liveN } = this.nfa;
    return liveN[start] ? shortestPath(states.length, start, this.nfaSucc(true), this.nfaFinal) : null;
  }

  /** Length of the longest match: Infinity if unbounded, null if nothing matches. */
  maxLength(): number | null {
    const { states, start, liveN } = this.nfa;
    return liveN[start] ? longestPath(states.length, start, this.nfaSucc(false), this.nfaFinal) : null;
  }

  /**
   * Every deterministic state reachable from the start, numbered 0..n-1.
   * Needed for raw lengths, which depend on whether a position is forced.
   */
  private explore(): DState[] {
    if (this.explored) return this.explored;
    const start = this.dfa.start;
    const list: DState[] = [];
    if (start) {
      const seen = new Set<DState>([start]);
      list.push(start);
      for (let i = 0; i < list.length; i++) {
        for (const { next } of this.dfa.transitions(list[i])) {
          if (seen.has(next)) continue;
          if (list.length >= MAX_EXPLORE_STATES) {
            throw new ValexUnsupportedError(`Pattern is too complex to measure (/${this.pattern}/)`);
          }
          seen.add(next);
          list.push(next);
        }
      }
    }
    this.explored = list;
    return list;
  }

  private rawLength(min: boolean): number | null {
    const list = this.explore();
    if (!list.length) return null;
    const index = new Map(list.map((d, i) => [d, i] as const));
    const succ: Succ = (v) => {
      const d = list[v];
      const forced = this.isForced(d);
      return this.dfa.transitions(d).map(({ set, next }) => {
        const w = forced ? 0 : min ? (set.hasBmp ? 1 : 2) : set.hasAstral ? 2 : 1;
        return [index.get(next)!, w] as [number, number];
      });
    };
    const final = (v: number) => list[v].accept;
    return min ? shortestPath(list.length, 0, succ, final) : longestPath(list.length, 0, succ, final);
  }

  /**
   * Fewest characters the user must choose, ignoring the ones the pattern
   * inserts: 10 for `\(\d{3}\) \d{3}-\d{4}`. This is the shortest
   * `unformat()` of a match. Null if nothing matches.
   */
  minValueLength(): number | null {
    return this.rawLength(true);
  }

  /** Most characters the user can choose (longest `unformat()` of a match); Infinity if unbounded. */
  maxValueLength(): number | null {
    return this.rawLength(false);
  }
}
