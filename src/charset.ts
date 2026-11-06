/** Highest Unicode code point. */
export const MAX_CODE_POINT = 0x10ffff;

/**
 * Immutable set of Unicode code points, stored as sorted, disjoint,
 * non-adjacent inclusive ranges.
 */
export class CharSet {
  /** Flat list: [lo0, hi0, lo1, hi1, ...]. */
  private readonly r: readonly number[];

  private constructor(r: readonly number[]) {
    this.r = r;
  }

  static readonly EMPTY: CharSet = new CharSet([]);
  static readonly ALL: CharSet = new CharSet([0, MAX_CODE_POINT]);

  static of(...codePoints: number[]): CharSet {
    return CharSet.fromRanges(codePoints.map((c) => [c, c] as const));
  }

  static range(lo: number, hi: number): CharSet {
    return lo > hi ? CharSet.EMPTY : new CharSet([lo, hi]);
  }

  static fromRanges(ranges: Iterable<readonly [number, number]>): CharSet {
    const list = [...ranges].filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0]);
    const out: number[] = [];
    for (const [lo, hi] of list) {
      const n = out.length;
      if (n > 0 && lo <= out[n - 1] + 1) {
        if (hi > out[n - 1]) out[n - 1] = hi;
      } else {
        out.push(lo, hi);
      }
    }
    return new CharSet(out);
  }

  get isEmpty(): boolean {
    return this.r.length === 0;
  }

  /** Number of code points in the set. */
  get size(): number {
    let n = 0;
    for (let i = 0; i < this.r.length; i += 2) n += this.r[i + 1] - this.r[i] + 1;
    return n;
  }

  /** Smallest code point, or undefined when empty. */
  first(): number | undefined {
    return this.r[0];
  }

  /** The only member when the set has exactly one code point. */
  single(): number | undefined {
    return this.r.length === 2 && this.r[0] === this.r[1] ? this.r[0] : undefined;
  }

  /** The k-th smallest member (0-based). */
  nth(k: number): number | undefined {
    for (let i = 0; i < this.r.length; i += 2) {
      const len = this.r[i + 1] - this.r[i] + 1;
      if (k < len) return this.r[i] + k;
      k -= len;
    }
    return undefined;
  }

  has(cp: number): boolean {
    let lo = 0;
    let hi = this.r.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < this.r[mid * 2]) hi = mid - 1;
      else if (cp > this.r[mid * 2 + 1]) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** True if any member lies outside the Basic Multilingual Plane. */
  get hasAstral(): boolean {
    return this.r.length > 0 && this.r[this.r.length - 1] > 0xffff;
  }

  /** True if any member lies inside the Basic Multilingual Plane. */
  get hasBmp(): boolean {
    return this.r.length > 0 && this.r[0] <= 0xffff;
  }

  ranges(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < this.r.length; i += 2) out.push([this.r[i], this.r[i + 1]]);
    return out;
  }

  /** Raw boundaries, for building partitions. */
  bounds(): readonly number[] {
    return this.r;
  }

  union(other: CharSet): CharSet {
    if (other.isEmpty) return this;
    if (this.isEmpty) return other;
    return CharSet.fromRanges([...this.ranges(), ...other.ranges()]);
  }

  intersect(other: CharSet): CharSet {
    const a = this.r;
    const b = other.r;
    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i], b[j]);
      const hi = Math.min(a[i + 1], b[j + 1]);
      if (lo <= hi) out.push(lo, hi);
      if (a[i + 1] < b[j + 1]) i += 2;
      else j += 2;
    }
    return new CharSet(out);
  }

  complement(): CharSet {
    const out: number[] = [];
    let next = 0;
    for (let i = 0; i < this.r.length; i += 2) {
      if (this.r[i] > next) out.push(next, this.r[i] - 1);
      next = this.r[i + 1] + 1;
    }
    if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
    return new CharSet(out);
  }

  minus(other: CharSet): CharSet {
    return this.intersect(other.complement());
  }

  equals(other: CharSet): boolean {
    return this.r.length === other.r.length && this.r.every((v, i) => v === other.r[i]);
  }

  /** Human-readable form, e.g. "[0-9a-f]". */
  toString(): string {
    const esc = (cp: number) =>
      cp >= 0x21 && cp <= 0x7e && !'\\]-^['.includes(String.fromCharCode(cp))
        ? String.fromCharCode(cp)
        : `\\u{${cp.toString(16)}}`;
    let s = '';
    for (const [lo, hi] of this.ranges()) s += lo === hi ? esc(lo) : `${esc(lo)}-${esc(hi)}`;
    return `[${s}]`;
  }
}
