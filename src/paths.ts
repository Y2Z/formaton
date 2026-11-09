/** Weighted successor list: [target, weight], weights are small non-negative integers. */
export type Succ = (v: number) => Array<[number, number]>;

/** Lightest path from `start` to any final node, or null if none is reachable. */
export function shortestPath(n: number, start: number, succ: Succ, isFinal: (v: number) => boolean): number | null {
  const dist = new Float64Array(n).fill(Infinity);
  const buckets: number[][] = [[start]];
  dist[start] = 0;
  for (let k = 0; k < buckets.length; k++) {
    for (const v of buckets[k] ?? []) {
      if (dist[v] !== k) continue;
      if (isFinal(v)) return k;
      for (const [t, w] of succ(v)) {
        if (dist[t] <= k + w) continue;
        dist[t] = k + w;
        (buckets[k + w] ??= []).push(t);
      }
    }
  }
  return null;
}

/**
 * Heaviest path from `start` to any final node. Infinity if a cycle with
 * positive weight is reachable, null if no final node is. Every reachable
 * node is assumed able to reach a final node.
 */
export function longestPath(n: number, start: number, succ: Succ, isFinal: (v: number) => boolean): number | null {
  // Iterative Tarjan SCC over nodes reachable from start.
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
    for (const v of comps[c]) {
      if (isFinal(v)) b = Math.max(b, 0);
      for (const [t, w] of succ(v)) {
        if (comp[t] === c) {
          if (w > 0) return Infinity;
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
