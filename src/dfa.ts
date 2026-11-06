import { CharSet } from './charset.js';
import type { Nfa } from './nfa.js';

/** A deterministic state: the set of live NFA states that can consume a character. */
export interface DState {
  readonly id: number;
  /** NFA states with outgoing character edges (sorted). */
  readonly states: readonly number[];
  /** Whether the input so far is a complete match. */
  readonly accept: boolean;
  /** Per-code-point step cache. */
  readonly byCp: Map<number, DState | null>;
  /** Outgoing transitions, partitioned by target; computed on demand. */
  trans?: Transition[];
  /** Union of all transition sets; computed on demand. */
  allowed?: CharSet;
}

export interface Transition {
  set: CharSet;
  next: DState;
}

/**
 * Subset construction done lazily: deterministic states are created only as
 * input actually reaches them, so huge patterns stay cheap.
 */
export class Dfa {
  readonly start: DState | null;
  private readonly cache = new Map<string, DState>();
  private readonly markN: Int32Array;
  private readonly markE: Int32Array;
  private gen = 0;

  constructor(private readonly nfa: Nfa) {
    this.markN = new Int32Array(nfa.states.length);
    this.markE = new Int32Array(nfa.states.length);
    this.start = this.make([nfa.start], true);
  }

  /** Number of deterministic states built so far. */
  get size(): number {
    return this.cache.size;
  }

  step(d: DState, cp: number): DState | null {
    const hit = d.byCp.get(cp);
    if (hit !== undefined) return hit;
    const { states, liveN } = this.nfa;
    const targets: number[] = [];
    for (const s of d.states) {
      for (const { set, to } of states[s].chars) {
        if (liveN[to] && set.has(cp)) targets.push(to);
      }
    }
    const next = targets.length ? this.make(targets, false) : null;
    d.byCp.set(cp, next);
    return next;
  }

  transitions(d: DState): Transition[] {
    if (d.trans) return d.trans;
    const { states, liveN } = this.nfa;
    const edges: Array<{ set: CharSet; to: number }> = [];
    for (const s of d.states) {
      for (const e of states[s].chars) if (liveN[e.to]) edges.push(e);
    }

    // Split the alphabet into elementary intervals at every edge boundary.
    const points = new Set<number>();
    for (const { set } of edges) {
      const b = set.bounds();
      for (let i = 0; i < b.length; i += 2) {
        points.add(b[i]);
        points.add(b[i + 1] + 1);
      }
    }
    const sorted = [...points].sort((a, b) => a - b);

    const groups = new Map<string, { ranges: Array<[number, number]>; targets: number[] }>();
    for (let i = 0; i + 1 < sorted.length; i++) {
      const lo = sorted[i];
      const hi = sorted[i + 1] - 1;
      const targets: number[] = [];
      for (const { set, to } of edges) if (set.has(lo)) targets.push(to);
      if (!targets.length) continue;
      targets.sort((a, b) => a - b);
      const key = targets.join(',');
      const g = groups.get(key);
      if (g) g.ranges.push([lo, hi]);
      else groups.set(key, { ranges: [[lo, hi]], targets });
    }

    const trans: Transition[] = [];
    for (const { ranges, targets } of groups.values()) {
      const next = this.make(targets, false);
      if (next) trans.push({ set: CharSet.fromRanges(ranges), next });
    }
    trans.sort((a, b) => a.set.first()! - b.set.first()!);
    d.trans = trans;
    return trans;
  }

  allowed(d: DState): CharSet {
    if (d.allowed) return d.allowed;
    let acc = CharSet.EMPTY;
    for (const t of this.transitions(d)) acc = acc.union(t.set);
    d.allowed = acc;
    return acc;
  }

  /** Epsilon closure of `seeds`, interned as a deterministic state. */
  private make(seeds: number[], atStart: boolean): DState | null {
    const { states, accept, liveN, liveE } = this.nfa;
    const gen = ++this.gen;
    const { markN, markE } = this;
    const consuming: number[] = [];
    let accepting = false;

    // Normal region: may still consume characters.
    const stackN: number[] = [];
    const stackE: number[] = [];
    const pushN = (s: number) => {
      if (markN[s] !== gen && liveN[s]) {
        markN[s] = gen;
        stackN.push(s);
      }
    };
    const pushE = (s: number) => {
      if (markE[s] !== gen && liveE[s]) {
        markE[s] = gen;
        stackE.push(s);
      }
    };
    for (const s of seeds) pushN(s);
    while (stackN.length) {
      const s = stackN.pop()!;
      const st = states[s];
      if (s === accept) accepting = true;
      if (st.chars.length) consuming.push(s);
      for (const t of st.eps) pushN(t);
      if (atStart) for (const t of st.bol) pushN(t);
      for (const t of st.eol) pushE(t);
    }
    // End region: past a `$`, only epsilon moves can still lead to acceptance.
    while (stackE.length) {
      const s = stackE.pop()!;
      const st = states[s];
      if (s === accept) accepting = true;
      for (const t of st.eps) pushE(t);
      if (atStart) for (const t of st.bol) pushE(t);
      for (const t of st.eol) pushE(t);
    }

    if (!consuming.length && !accepting) return null;
    consuming.sort((a, b) => a - b);
    const key = (accepting ? 'A' : 'R') + consuming.join(',');
    let d = this.cache.get(key);
    if (!d) {
      d = { id: this.cache.size, states: consuming, accept: accepting, byCp: new Map() };
      this.cache.set(key, d);
    }
    return d;
  }
}
