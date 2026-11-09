/**
 * A pattern matching the decimal integers lo..hi (no leading zeros, no sign).
 * Used to give `<input type="number" min max>` a typing model: with max=12,
 * "2" is final but "1" may still become "10".."12".
 */
export function integerRangePattern(lo: number, hi: number): string {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || lo > hi) {
    throw new RangeError(`Invalid integer range ${lo}..${hi}`);
  }
  const a = String(lo);
  const b = String(hi);
  const parts: string[] = [];
  for (let len = a.length; len <= b.length; len++) {
    const from = len === a.length ? a : len === 1 ? '0' : '1' + '0'.repeat(len - 1);
    const to = len === b.length ? b : '9'.repeat(len);
    parts.push(sameLength(from, to));
  }
  return parts.length === 1 ? parts[0] : parts.join('|');
}

/** Pattern for all digit strings between `a` and `b` of the same length. */
function sameLength(a: string, b: string): string {
  const n = a.length;
  if (n === 0) return '';
  if (a === b) return a;
  if (a[0] === b[0]) return a[0] + group(sameLength(a.slice(1), b.slice(1)));
  const restA = a.slice(1);
  const restB = b.slice(1);
  let first = Number(a[0]);
  let last = Number(b[0]);
  const parts: string[] = [];
  if (n > 1 && !/^0*$/.test(restA)) {
    parts.push(a[0] + group(sameLength(restA, '9'.repeat(n - 1))));
    first++;
  }
  let high: string | null = null;
  if (n > 1 && !/^9*$/.test(restB)) {
    high = b[0] + group(sameLength('0'.repeat(n - 1), restB));
    last--;
  }
  if (first <= last) {
    const digit = first === last ? String(first) : `[${first}-${last}]`;
    parts.push(digit + (n > 1 ? `[0-9]{${n - 1}}` : ''));
  }
  if (high) parts.push(high);
  return parts.length === 1 ? parts[0] : `(?:${parts.join('|')})`;
}

const group = (p: string) => (p.includes('|') && !p.startsWith('(?:') ? `(?:${p})` : p);
