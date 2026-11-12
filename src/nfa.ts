import type { CharSet } from './charset.js';
import { FormatonUnsupportedError } from './errors.js';
import type { Node } from './parser.js';

/**
 * Thompson NFA state. Besides plain epsilon edges there are two guarded
 * kinds: `bol` (`^`, passable only at position 0) and `eol` (`$`). Once a
 * path crosses `$` it may not consume any more characters.
 */
export interface NfaState {
  eps: number[];
  bol: number[];
  eol: number[];
  chars: Array<{ set: CharSet; to: number }>;
}

export interface Nfa {
  states: NfaState[];
  start: number;
  accept: number;
  /** Can reach acceptance while still allowed to consume characters. */
  liveN: Uint8Array;
  /** Can reach acceptance using only epsilon moves (after a `$`). */
  liveE: Uint8Array;
}

export const MAX_STATES = 200_000;

export function buildNfa(ast: Node): Nfa {
  const states: NfaState[] = [];
  const add = (): number => {
    if (states.length >= MAX_STATES) throw new FormatonUnsupportedError('Pattern is too large');
    states.push({ eps: [], bol: [], eol: [], chars: [] });
    return states.length - 1;
  };

  interface Frag {
    s: number;
    e: number;
  }

  const build = (n: Node): Frag => {
    switch (n.t) {
      case 'set': {
        const s = add();
        const e = add();
        if (!n.set.isEmpty) states[s].chars.push({ set: n.set, to: e });
        return { s, e };
      }
      case 'assert': {
        const s = add();
        const e = add();
        (n.kind === '^' ? states[s].bol : states[s].eol).push(e);
        return { s, e };
      }
      case 'seq': {
        if (n.items.length === 0) {
          const s = add();
          return { s, e: s };
        }
        let f = build(n.items[0]);
        for (let i = 1; i < n.items.length; i++) {
          const g = build(n.items[i]);
          states[f.e].eps.push(g.s);
          f = { s: f.s, e: g.e };
        }
        return f;
      }
      case 'alt': {
        const s = add();
        const e = add();
        for (const o of n.options) {
          const f = build(o);
          states[s].eps.push(f.s);
          states[f.e].eps.push(e);
        }
        return { s, e };
      }
      case 'rep': {
        const s = add();
        let cur = s;
        for (let i = 0; i < n.min; i++) {
          const f = build(n.node);
          states[cur].eps.push(f.s);
          cur = f.e;
        }
        const e = add();
        if (n.max === Infinity) {
          const f = build(n.node);
          states[cur].eps.push(f.s, e);
          states[f.e].eps.push(f.s, e);
        } else {
          // x{0,k} as (x(x(x)?)?)? so the NFA stays linear in k.
          for (let i = n.min; i < n.max; i++) {
            const f = build(n.node);
            states[cur].eps.push(f.s, e);
            cur = f.e;
          }
          states[cur].eps.push(e);
        }
        return { s, e };
      }
    }
  };

  const f = build(ast);
  const nfa: Nfa = {
    states,
    start: f.s,
    accept: f.e,
    liveN: new Uint8Array(states.length),
    liveE: new Uint8Array(states.length),
  };
  computeLiveness(nfa);
  return nfa;
}

/** Marks states from which acceptance is reachable (two regions, see Nfa). */
function computeLiveness(nfa: Nfa): void {
  const { states, accept, liveN, liveE } = nfa;
  const n = states.length;

  // Reverse adjacency, split by edge kind.
  const revEpsAll: number[][] = Array.from({ length: n }, () => []); // eps, bol, eol
  const revN: number[][] = Array.from({ length: n }, () => []); // eps, bol, chars
  states.forEach((st, i) => {
    for (const t of st.eps) {
      revEpsAll[t].push(i);
      revN[t].push(i);
    }
    for (const t of st.bol) {
      revEpsAll[t].push(i);
      revN[t].push(i);
    }
    for (const t of st.eol) revEpsAll[t].push(i);
    for (const { to } of st.chars) revN[to].push(i);
  });

  const flood = (mark: Uint8Array, seeds: number[], rev: number[][]) => {
    const stack = [...seeds];
    for (const s of seeds) mark[s] = 1;
    while (stack.length) {
      const x = stack.pop()!;
      for (const p of rev[x]) {
        if (!mark[p]) {
          mark[p] = 1;
          stack.push(p);
        }
      }
    }
  };

  flood(liveE, [accept], revEpsAll);

  const seedsN = [accept];
  states.forEach((st, i) => {
    if (st.eol.some((t) => liveE[t])) seedsN.push(i);
  });
  flood(liveN, seedsN, revN);
}
