import { CharSet, MAX_CODE_POINT } from './charset.js';
import { Dfa, type DState, type Transition } from './dfa.js';
import { ValexSyntaxError, ValexUnsupportedError } from './errors.js';
import { buildNfa, type Nfa } from './nfa.js';
import { parse, SPACE, type Mode } from './parser.js';

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
}

export interface ExampleOptions {
  /** Start from this (viable) prefix and complete it. */
  prefix?: string;
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

  private forcedRun(d: DState): { chars: string[]; states: DState[] } {
    const chars: string[] = [];
    const states: DState[] = [];
    while (!d.accept && chars.length < MAX_FORCED) {
      const t = this.dfa.transitions(d);
      if (t.length !== 1) break;
      const only = t[0].set.single();
      if (only === undefined) break;
      chars.push(String.fromCodePoint(only));
      d = t[0].next;
      states.push(d);
    }
    return { chars, states };
  }

  /**
   * Corrects typed or pasted text: flips letter case where only the other case
   * fits, and inserts separators the user skipped. Pasting "2125551234" into
   * `\(\d{3}\) \d{3}-\d{4}` gives "(212) 555-1234".
   */
  fix(value: string, options: FixOptions = {}): FixResult {
    const { caseFix = true, insertForced = true, drop = false } = options;
    let d = this.dfa.start;
    if (!d) return { value: '', ok: value === '', complete: false };
    let out = '';
    let ok = true;

    for (const ch of value) {
      const tries = [ch];
      if (caseFix) {
        for (const alt of [ch.toLowerCase(), ch.toUpperCase()]) {
          if (alt !== ch && Array.from(alt).length === 1 && !tries.includes(alt)) tries.push(alt);
        }
      }

      let placed = false;
      for (const c of tries) {
        const next = this.dfa.step(d, c.codePointAt(0)!);
        if (next) {
          out += c;
          d = next;
          placed = true;
          break;
        }
      }

      if (!placed && insertForced) {
        const run = this.forcedRun(d);
        if (run.chars.length) {
          // The user typed a separator further along: "(212 " -> "(212) ".
          for (const c of tries) {
            const idx = run.chars.indexOf(c);
            if (idx >= 0) {
              out += run.chars.slice(0, idx + 1).join('');
              d = run.states[idx];
              placed = true;
              break;
            }
          }
          // The user skipped the separators: "(2125" -> "(212) 5".
          if (!placed) {
            const end = run.states[run.states.length - 1];
            for (const c of tries) {
              const next = this.dfa.step(end, c.codePointAt(0)!);
              if (next) {
                out += run.chars.join('') + c;
                d = next;
                placed = true;
                break;
              }
            }
          }
        }
      }

      if (!placed) {
        ok = false;
        if (!drop) break;
      }
    }

    return { value: out, ok, complete: d.accept };
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

  // ---- generation ------------------------------------------------------------

  /**
   * A matching string, for placeholders. With `mask: "_"` the phone pattern
   * gives "(___) ___-____"; with `prefix: "(212"` it gives "(212) ___-____".
   * Returns null if no match is reachable.
   */
  example(options: ExampleOptions = {}): string | null {
    const from = this.walk(options.prefix ?? '');
    if (!from) return null;
    const path = (options.length === 'max' ? this.longestPath(from) : null) ?? this.shortestPath(from);
    if (!path) return null;
    let out = options.prefix ?? '';
    for (const { state, t } of path) {
      const free = this.dfa.allowed(state).single() === undefined;
      out += free && options.mask !== undefined ? options.mask : String.fromCodePoint(pickChar(t.set, options.random));
    }
    return out;
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

  /** Length of the shortest match, or null if nothing matches. */
  minLength(): number | null {
    const { states, start, accept, liveN, liveE } = this.nfa;
    if (!liveN[start]) return null;
    const dist = new Float64Array(states.length).fill(Infinity);
    const buckets: number[][] = [[start]];
    dist[start] = 0;
    for (let k = 0; k < buckets.length; k++) {
      for (const s of buckets[k] ?? []) {
        if (dist[s] !== k) continue;
        const st = states[s];
        if (s === accept || st.eol.some((t) => liveE[t])) return k;
        const relax = (t: number, w: number) => {
          if (!liveN[t] || dist[t] <= k + w) return;
          dist[t] = k + w;
          (buckets[k + w] ??= []).push(t);
        };
        for (const t of st.eps) relax(t, 0);
        for (const t of st.bol) relax(t, 0);
        for (const { set, to } of st.chars) relax(to, set.hasBmp ? 1 : 2);
      }
    }
    return null;
  }

  /** Length of the longest match: Infinity if unbounded, null if nothing matches. */
  maxLength(): number | null {
    const { states, start, accept, liveN, liveE } = this.nfa;
    if (!liveN[start]) return null;
    const n = states.length;
    const succ = (s: number): Array<[number, number]> => {
      const st = states[s];
      const out: Array<[number, number]> = [];
      for (const t of st.eps) if (liveN[t]) out.push([t, 0]);
      for (const t of st.bol) if (liveN[t]) out.push([t, 0]);
      for (const { set, to } of st.chars) if (liveN[to]) out.push([to, set.hasAstral ? 2 : 1]);
      return out;
    };

    // Iterative Tarjan SCC over live states reachable from start.
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const comp = new Int32Array(n).fill(-1);
    const onStack = new Uint8Array(n);
    const stack: number[] = [];
    const comps: number[][] = [];
    let counter = 0;
    const work: Array<{ v: number; edges: Array<[number, number]>; i: number }> = [];
    const open = (v: number) => {
      index[v] = low[v] = counter++;
      stack.push(v);
      onStack[v] = 1;
      work.push({ v, edges: succ(v), i: 0 });
    };
    open(start);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.edges.length) {
        const [w] = frame.edges[frame.i++];
        if (index[w] < 0) open(w);
        else if (onStack[w]) low[frame.v] = Math.min(low[frame.v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low[parent] = Math.min(low[parent], low[frame.v]);
      }
      if (low[frame.v] === index[frame.v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = comps.length;
          members.push(w);
        } while (w !== frame.v);
        comps.push(members);
      }
    }

    // Tarjan emits components sinks-first, so successors are already solved.
    const best = new Float64Array(comps.length).fill(-Infinity);
    for (let c = 0; c < comps.length; c++) {
      let b = -Infinity;
      for (const s of comps[c]) {
        if (s === accept || states[s].eol.some((t) => liveE[t])) b = Math.max(b, 0);
        for (const [t, w] of succ(s)) {
          if (comp[t] === c) {
            if (w > 0) return Infinity; // a character-consuming cycle
          } else {
            b = Math.max(b, w + best[comp[t]]);
          }
        }
      }
      best[c] = b;
    }
    const result = best[comp[start]];
    return result === -Infinity ? null : result;
  }
}
