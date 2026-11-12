import { integerRangePattern } from './range.js';
import { compile, FormatonSyntaxError, FormatonUnsupportedError, type Formaton } from './formaton.js';

export type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export interface AttachOptions {
  /** Use this pattern instead of the element's `pattern` attribute or type. */
  pattern?: string;
  /**
   * Placeholder to set when the element has none. `auto` (default) uses a
   * mask such as "(___) ___-____" when every value has that shape (fixed
   * length, with fixed characters to show), and leaves the placeholder alone
   * otherwise: a mask for varying lengths would mislead.
   */
  placeholder?: 'auto' | 'mask' | 'example' | false;
  /** Stand-in character for masks. Default "_". */
  maskChar?: string;
  /**
   * Set `maxlength` from the pattern when the element has none. Default
   * false: formaton already enforces the length, and at `maxlength` browsers
   * swallow keystrokes and truncate pastes before formaton can see them.
   */
  maxLength?: boolean;
  /**
   * Fill in the characters every value starts with ("+1 (") on focus, keep
   * them while the field has focus, and clear them on blur if nothing else
   * was typed. Default true.
   */
  prefix?: boolean;
  /**
   * What typing in the middle of a value does to the characters after the caret:
   * - `overwrite`: each typed character replaces the next one, like a paper form
   * - `shift`: the rest moves along to make room; what no longer fits is lost
   * - `truncate`: everything after the caret is cleared, to be typed again
   * - `auto` (default): `overwrite` where every value has the same number of
   *   characters to type (phone numbers, dates, times), `shift` otherwise
   *   (email addresses, anything of varying length)
   * Deleting always pulls the rest back, except in `truncate` mode.
   */
  editMode?: 'auto' | 'overwrite' | 'shift' | 'truncate';
  /**
   * Type out characters formaton adds at the end of the value (separators,
   * completed words like "January", a "+1 (" prefix) one by one, very fast,
   * so the user sees them arrive. `true` (default): 15 ms per character, at
   * most 200 ms in all; a number: milliseconds per character; `false`: off.
   * Off when the user prefers reduced motion. Any key, click or paste
   * finishes it at once, so it never slows typing down.
   */
  animate?: boolean | number;
  /** Move focus to the next field once this one is filled. Default false. */
  autoAdvance?: boolean;
  /**
   * The value has become a valid, complete match: "123" or "1234" for a CVV,
   * "12345" or "12345-6789" for a ZIP code. More may still follow.
   */
  onComplete?: (value: string, binding: Binding) => void;
  /**
   * The value is complete and nothing more can be typed: a full phone
   * number, a 4-digit CVV, but not five digits of a ZIP code that may still
   * get "-1234". This is when `autoAdvance` moves on.
   */
  onFilled?: (value: string, binding: Binding) => void;
  /** The user typed or pasted something that does not fit; `rejected` is that text. */
  onReject?: (rejected: string, binding: Binding) => void;
}

export interface Binding {
  readonly element: FieldElement;
  /** The compiled pattern, or null when the field gets no assistance. */
  readonly formaton: Formaton | null;
  /** What drives the field: typing assistance, a native widget, or nothing. */
  readonly kind: 'text' | 'number' | 'native' | 'none';
  /** Whether the value is a valid, complete match (see `onComplete`). */
  readonly complete: boolean;
  /** Whether the value is complete and cannot grow (see `onFilled`). */
  readonly filled: boolean;
  /** The value without the characters the pattern dictates; settable. */
  rawValue: string;
  /** Removes all listeners and attributes formaton added. */
  detach(): void;
}

/** The email grammar from the HTML standard, as a pattern. */
export const EMAIL_PATTERN =
  "[a-zA-Z0-9.!#$%&'*+\\/=?\\^_`\\{\\|\\}~\\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?" +
  '(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?)*';

/** Types the browser renders as its own widget: no typing assistance possible. */
const NATIVE_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local']);
/** Types whose text formaton can edit. */
const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'textarea']);

const bindings = new WeakMap<FieldElement, Binding>();

/**
 * Characters formaton appended to complete a field just before autoAdvance
 * left it (the "M" of "9:30PM"). Typed into the next field right after, out
 * of habit, they are dropped instead of landing there.
 */
let carry = { text: '', until: 0 };
const CARRY_MS = 1500;
/** Longest a typing animation may take, however many characters. */
const MAX_ANIMATION_MS = 200;

/**
 * Attaches to every `<input>` and `<textarea>` under `root`; returns the ones
 * that got assistance. `options` may be a function giving each element its
 * own options.
 */
export function attachAll(
  root: ParentNode = document,
  options: AttachOptions | ((el: FieldElement) => AttachOptions) = {},
): Binding[] {
  const out: Binding[] = [];
  for (const el of root.querySelectorAll<FieldElement>('input, textarea')) {
    const b = attach(el, typeof options === 'function' ? options(el) : options);
    if (b.kind === 'none') b.detach();
    else out.push(b);
  }
  return out;
}

/** Prefix of the HTML attributes that set options per element. */
export const ATTRIBUTE_PREFIX = 'data-formaton-';

/**
 * Options set in the element's HTML, which win over the ones passed in:
 * data-formaton-prefix="false", data-formaton-animate="30",
 * data-formaton-auto-advance, data-formaton-edit-mode="shift",
 * data-formaton-placeholder="mask", data-formaton-mask-char="#",
 * data-formaton-max-length, data-formaton-pattern="..." (for a textarea).
 */
export function attributeOptions(el: Element): AttachOptions {
  const out: AttachOptions = {};
  const get = (name: string) => el.getAttribute(ATTRIBUTE_PREFIX + name);
  const flag = (v: string | null) => (v === null ? undefined : v === '' || v === 'true' || v === 'on' || v === 'yes');
  const prefix = flag(get('prefix'));
  if (prefix !== undefined) out.prefix = prefix;
  const advance = flag(get('auto-advance'));
  if (advance !== undefined) out.autoAdvance = advance;
  const maxLength = flag(get('max-length'));
  if (maxLength !== undefined) out.maxLength = maxLength;
  const animate = get('animate');
  if (animate !== null) out.animate = /^\d+(\.\d+)?$/.test(animate) ? Number(animate) : (flag(animate) as boolean);
  const editMode = get('edit-mode');
  if (editMode === 'auto' || editMode === 'overwrite' || editMode === 'shift' || editMode === 'truncate') out.editMode = editMode;
  const placeholder = get('placeholder');
  if (placeholder === 'auto' || placeholder === 'mask' || placeholder === 'example') out.placeholder = placeholder;
  else if (placeholder !== null && flag(placeholder) === false) out.placeholder = false;
  const maskChar = get('mask-char');
  if (maskChar) out.maskChar = maskChar;
  const pattern = get('pattern');
  if (pattern !== null) out.pattern = pattern;
  return out;
}

/**
 * Attaches formaton to an `<input>` or `<textarea>`. The pattern comes from
 * `options.pattern`, then the `pattern` attribute, then the type: `email`,
 * `number` with integer `min`/`max`, and the date and time types.
 * Attaching twice returns the existing binding. `data-formaton-*` attributes
 * on the element override `options` (see `attributeOptions`).
 */
export function attach(el: FieldElement, passed: AttachOptions = {}): Binding {
  const existing = bindings.get(el);
  if (existing) return existing;
  const options: AttachOptions = { ...passed, ...attributeOptions(el) };

  const type = el instanceof HTMLTextAreaElement ? 'textarea' : (el.type || 'text').toLowerCase();
  const pattern = options.pattern ?? el.getAttribute('pattern') ?? defaultPattern(el, type);
  let v: Formaton | null = null;
  if (pattern !== null) {
    try {
      v = compile(pattern);
    } catch (e) {
      // Browsers ignore invalid patterns, and some valid ones we cannot model.
      if (!(e instanceof FormatonSyntaxError || e instanceof FormatonUnsupportedError)) throw e;
    }
  }

  let kind: Binding['kind'] = 'none';
  if (NATIVE_TYPES.has(type)) kind = 'native';
  else if (v && type === 'number') kind = 'number';
  else if (v && TEXT_TYPES.has(type)) kind = 'text';

  const cleanup: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(name: K, fn: (ev: HTMLElementEventMap[K]) => void) => {
    el.addEventListener(name, fn as EventListener);
    cleanup.push(() => el.removeEventListener(name, fn as EventListener));
  };

  let filled = false;
  let complete = false;
  /** Separators formaton just inserted, ending at `at`, which the user may type over once. */
  let pending = { text: '', at: -1 };
  const binding: Binding = {
    element: el,
    formaton: kind === 'native' ? null : v,
    kind,
    get complete() {
      return complete;
    },
    get filled() {
      return filled;
    },
    get rawValue() {
      return v && kind === 'text' ? v.unformat(el.value) : el.value;
    },
    set rawValue(raw: string) {
      el.value = v && kind === 'text' ? v.format(raw).value : raw;
      snapshot(el.value.length);
      filled = isFilled(el.value);
      complete = isComplete(el.value);
    },
    detach() {
      for (const fn of cleanup.splice(0)) fn();
      bindings.delete(el);
    },
  };
  bindings.set(el, binding);

  const isComplete = (value: string): boolean => {
    if (kind === 'native') return isFilled(value);
    return !!v && value !== '' && v.test(value);
  };

  const isFilled = (value: string): boolean => {
    if (kind === 'native') {
      // Chrome reports a partly typed year as "0002-12-31", "0020-12-31", ...
      return value !== '' && el.validity.valid && !/^0/.test(value);
    }
    return !!v && v.test(value) && (v.allowedNext(value)?.isEmpty ?? true);
  };

  /**
   * Updates `filled`. onFilled fires when the value becomes filled, and also
   * when the user re-types the end of a filled value (fixing its last
   * character), so autoAdvance moves on just like the first time.
   */
  const fill = (value: string, atEnd: boolean, typedAtEnd = false) => {
    const nowComplete = isComplete(value);
    if (nowComplete && !complete) {
      complete = true;
      options.onComplete?.(value, binding);
    }
    complete = nowComplete;
    const now = isFilled(value);
    if (now && (!filled || (typedAtEnd && atEnd))) {
      filled = true;
      options.onFilled?.(value, binding);
      if (options.autoAdvance && atEnd && document.activeElement === el) {
        carry = { text: pending.at === el.value.length ? pending.text : '', until: Date.now() + CARRY_MS };
        focusNext(el);
      }
    }
    filled = now;
  };

  if (kind === 'native') {
    filled = isFilled(el.value);
    complete = isComplete(el.value);
    listen('input', () => fill(el.value, true));
    return binding;
  }
  if (kind === 'none' || !v) return binding;
  const vx = v;

  // ---- attributes ----------------------------------------------------------

  const setAttr = (name: string, value: string) => {
    el.setAttribute(name, value);
    cleanup.push(() => {
      if (el.getAttribute(name) === value) el.removeAttribute(name);
    });
  };
  if (kind === 'text') {
    if (!el.hasAttribute('placeholder') && options.placeholder !== false) {
      const char = options.maskChar ?? '_';
      const mode = options.placeholder ?? 'auto';
      const mask = vx.mask('', { char });
      let text: string | null = null;
      // A mask helps when every value has its shape: fixed length, with fixed
      // characters to show ("(___) ___-____", "DE__ ____ ..."). For varying
      // lengths it would mislead (a Visa number in an Amex-shaped mask).
      const fixed = mask === null ? [] : [...mask].filter((c) => c !== char);
      let sameShape = false;
      try {
        sameShape = vx.minLength() === vx.maxLength() && vx.minValueLength() === vx.maxValueLength();
      } catch {
        // too complex to measure
      }
      const helpful = fixed.length > 0 && sameShape;
      if (mode === 'mask' || (mode === 'auto' && helpful)) text = mask;
      else if (mode === 'example') text = vx.example();
      if (text) setAttr('placeholder', text);
    }
    const max = vx.maxLength();
    if (options.maxLength && !el.hasAttribute('maxlength') && max !== null && max !== Infinity) {
      setAttr('maxlength', String(max));
    }
  }

  // ---- number fields: no caret control, so only accept or revert ----------------

  if (kind === 'number') {
    let last = vx.isPrefix(el.value) ? el.value : '';
    filled = isFilled(last);
    complete = isComplete(last);
    // A number field's text is unreadable while it is not a valid number
    // ("-", "1e", and in Firefox "1a"), so characters the pattern never uses
    // are stopped before they get in.
    const alphabet = vx.alphabet();
    listen('beforeinput', (ev) => {
      if (swallowCarry(ev)) return;
      const data = ev.data ?? ev.dataTransfer?.getData('text/plain') ?? null;
      if (!data || !ev.inputType.startsWith('insert')) return;
      if ([...data].some((c) => !alphabet.has(c.codePointAt(0)!))) {
        ev.preventDefault();
        options.onReject?.(data, binding);
      }
    });
    listen('input', () => {
      const value = el.value;
      if (value !== '' && !vx.isPrefix(value)) {
        options.onReject?.(value.startsWith(last) ? value.slice(last.length) : value, binding);
        el.value = last;
        return;
      }
      last = value;
      fill(value, true);
    });
    return binding;
  }

  // ---- text fields ------------------------------------------------------------

  const prefixOn = options.prefix ?? true;
  let before = { value: el.value, start: el.value.length, end: el.value.length };

  let composing = false;

  /** The selection, or null where the element has no selection API (type=email). */
  const selection = (): [number, number] | null => {
    try {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (s !== null && e !== null) return [s, e];
    } catch {
      // type=email
    }
    return null;
  };
  const setCaret = (pos: number) => {
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // type=email has no selection API, and setting its value moves the
      // caret to the end. As a text field for a moment, it takes a caret.
      if (el instanceof HTMLInputElement) {
        const type = el.type;
        try {
          el.type = 'text';
          el.setSelectionRange(pos, pos);
        } finally {
          el.type = type;
        }
      }
    }
  };
  const snapshot = (caret: number) => {
    before = { value: el.value, start: caret, end: caret };
  };

  const apply = (value: string, caret: number, selectionEnd = caret) => {
    const changed = el.value !== value;
    if (changed) el.value = value;
    // Without a selection API we only know roughly where an edit happened
    // ("comm" + "m": which "m"?). If formaton left the value as the browser made
    // it, the browser's caret is right, so leave it alone.
    if (document.activeElement === el && (changed || selection() !== null)) {
      if (selectionEnd !== caret) {
        try {
          el.setSelectionRange(caret, selectionEnd);
        } catch {
          setCaret(caret);
        }
      } else {
        setCaret(caret);
      }
    }
    before = { value, start: caret, end: selectionEnd };
  };


  const editMode = (wasFilled: boolean): 'overwrite' | 'shift' | 'truncate' => {
    const mode = options.editMode ?? 'auto';
    if (mode !== 'auto') return mode;
    // Room left: make room. Nothing left to add: replace.
    return wasFilled ? 'overwrite' : 'shift';
  };

  /** UTF-16 [start, end) of each character of `s`, and whether formaton inserted it by itself. */
  const charSpans = (s: string): Array<{ start: number; end: number; auto: boolean }> => {
    const auto = vx.autoChars(s);
    const out: Array<{ start: number; end: number; auto: boolean }> = [];
    let at = 0;
    let i = 0;
    for (const ch of s) {
      out.push({ start: at, end: at + ch.length, auto: auto[i++] });
      at += ch.length;
    }
    return out;
  };

  /** Moves `caret` past separators formaton inserts, so typing continues at the next choice. */
  const skipAuto = (s: string, caret: number): number => {
    for (const c of charSpans(s)) if (c.start === caret && c.auto) caret = c.end;
    return caret;
  };

  /**
   * [p, q] for an edit that ends at the caret: old = value[0, p) + removed +
   * value[caret..], value = value[0, p) + inserted + value[caret..]. Null if
   * that does not fit, or the caret cannot be read (type=email).
   */
  const anchored = (old: string, value: string): [number, number] | null => {
    const sel = selection();
    if (!sel) return null;
    const c = sel[1];
    const p = Math.min(c, before.start);
    const q = value.length - c;
    if (p + q > old.length || !old.startsWith(value.slice(0, p)) || !old.endsWith(value.slice(c))) return null;
    return [p, q];
  };

  const handle = (inputType: string) => {
    const value = el.value;
    const old = before.value;
    const wasFilled = isFilled(old);

    // What changed: old = head + removed + tail, value = head + inserted + tail.
    let p: number;
    let q: number;
    const { start, end } = before;
    if (
      value.length >= start + (old.length - end) &&
      value.startsWith(old.slice(0, start)) &&
      value.endsWith(old.slice(end))
    ) {
      p = start;
      q = old.length - end;
    } else if (anchored(old, value)) {
      // The browser's caret after the edit marks where it happened. Comparing
      // strings alone cannot tell which "2" of "22:2" a Backspace removed.
      [p, q] = anchored(old, value)!;
    } else {
      p = 0;
      while (p < old.length && p < value.length && old[p] === value[p]) p++;
      q = 0;
      while (q < old.length - p && q < value.length - p && old[old.length - 1 - q] === value[value.length - 1 - q]) q++;
    }
    const inserted = value.slice(p, value.length - q);
    let head = old.slice(0, p);
    let tailStart = old.length - q;

    let result: string;
    let caret: number;
    let typedAtEnd = false;
    /** Where characters formaton appended at the end start, to type them out. */
    let animateFrom = -1;
    if (inserted !== '') {
      const auto = pending.at === p && tailStart === p ? pending.text : '';
      pending = { text: '', at: -1 };
      // Separators formaton just put before the caret may be typed once more, out
      // of habit: ")" or ") " after "(212" became "(212) ", "-" after "2012"
      // became "2012-". Matched from their start, or ending at the caret
      // (" " alone); a "1" after "+1 (" or a second "-" is not a re-type.
      if (auto && inserted.length <= auto.length && (auto.startsWith(inserted) || auto.endsWith(inserted))) {
        pending = { text: auto.startsWith(inserted) ? auto.slice(inserted.length) : '', at: p };
        apply(old, p);
        return;
      }
      // Separators ahead of the caret are stepped over ("12|:54" + ":").
      if (tailStart === p && old.startsWith(inserted, p)) {
        const ahead = charSpans(old).filter((c) => c.start >= p && c.end <= p + inserted.length);
        if (ahead.length && ahead.every((c) => c.auto)) {
          apply(old, p + inserted.length);
          return;
        }
      }
      const count = (v: string) => Array.from(vx.unformat(v)).length;
      let placed = vx.fix(head + inserted);
      let typed = count(placed.value) - count(head);
      if (placed.rejected) {
        // A paste may repeat separators the field already shows ("+1 (" +
        // "+1 212..."): try it in place of them.
        const base = vx.trimForced(head);
        const alt = vx.fix(base + inserted);
        const altTyped = count(alt.value) - count(base);
        if (altTyped > typed) {
          placed = alt;
          typed = altTyped;
        }
      }
      if (placed.rejected) options.onReject?.(placed.rejected, binding);
      if (typed <= 0 && (placed.rejected || (tailStart === p && placed.value === head))) {
        // Nothing fitting got in: keep the old value, and the selection it
        // would have replaced. Only fitting characters replace anything.
        if (tailStart > p) apply(old, before.start, before.end);
        else apply(old, p);
        return;
      }
      // Otherwise the user added characters, or a separator that was not
      // there yet (the optional "-" of a ZIP+4 code). The rest of the old
      // value is re-flowed from the characters the user chose.
      let tail = Array.from(vx.unformat(old, tailStart));
      const mode = editMode(wasFilled);
      if (mode === 'truncate') tail = [];
      else if (mode === 'overwrite' && tailStart === p) tail = tail.slice(Math.max(typed, 0));
      result = vx.fix(placed.value + tail.join(''), { drop: true }).value;
      caret = result.startsWith(placed.value) ? skipAuto(result, placed.value.length) : result.length;
      // Separators the value now needs at its end come back wherever the
      // caret is: replacing the "2" of "+1 (234) " keeps the ") ".
      const atEnd = caret === result.length;
      if (atEnd) animateFrom = result.length;
      result += vx.forced(result);
      if (atEnd) caret = result.length;
      if (result.startsWith(placed.value) && caret > placed.value.length) {
        pending = { text: result.slice(placed.value.length, caret), at: caret };
      }
      typedAtEnd = true;
    } else if (tailStart > p) {
      pending = { text: '', at: -1 };
      // Deleting only separators formaton inserted would change nothing: take
      // the next chosen character with them, in the direction of the deletion.
      const spans = charSpans(old);
      const removed = spans.filter((c) => c.start >= p && c.end <= tailStart);
      if (removed.length && removed.every((c) => c.auto)) {
        if (/Forward/.test(inputType)) {
          const next = spans.find((c) => c.start >= tailStart && !c.auto);
          if (next) tailStart = next.end;
        } else {
          const prev = spans.filter((c) => c.end <= p && !c.auto).pop();
          if (prev) head = old.slice(0, prev.start);
        }
      }
      // Separators the user would get back on typing the next character stay
      // ("1QWS1-1" minus "1" is "1QWS1-"); optional ones do not.
      const tailRaw = options.editMode === 'truncate' ? '' : vx.unformat(old, tailStart);
      result = vx.fix(head + tailRaw, { drop: true }).value;
      // Separators the rest now needs come back, as they would when typing:
      // "22:2" minus the first "2" is "22:".
      result += vx.forced(result);
      // The caret stays where the deletion happened (Delete never moves it).
      caret = Math.min(head.length, result.length);
    } else {
      // Nothing we can attribute (e.g. a sanitized type=email value).
      result = vx.fix(value, { drop: true }).value;
      caret = result.length;
    }

    if (prefixOn && result === '' && document.activeElement === el) {
      result = vx.prefix();
      caret = result.length;
      animateFrom = 0;
    }
    const atEnd = caret === result.length;
    typeOut(result, caret, animateFrom, () => fill(result, atEnd, typedAtEnd));
  };

  // ---- typing animation ----------------------------------------------------------

  let anim: { final: string; caret: number; timer: ReturnType<typeof setTimeout>; done: () => void } | null = null;

  const delay = (): number => {
    const a = options.animate ?? true;
    if (a === false) return 0;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    return a === true ? 15 : Math.max(0, a);
  };

  /** Ends a running animation at once: the full value, then what was waiting on it. */
  const finish = () => {
    if (!anim) return;
    const a = anim;
    anim = null;
    clearTimeout(a.timer);
    apply(a.final, a.caret);
    a.done();
  };

  /**
   * Shows `value`, typing out what follows `from` one character at a time
   * (from < 0: no animation), then calls `done`.
   */
  const typeOut = (value: string, caret: number, from: number, done: () => void) => {
    finish();
    const chars = from >= 0 ? Array.from(value.slice(from)) : [];
    const ms = delay();
    if (!chars.length || !ms || document.activeElement !== el || caret !== value.length) {
      apply(value, caret);
      done();
      return;
    }
    const step = Math.min(ms, MAX_ANIMATION_MS / chars.length);
    let shown = from;
    let i = 0;
    apply(value.slice(0, from), from);
    const tick = () => {
      if (!anim) return;
      shown += chars[i++].length;
      el.value = value.slice(0, shown);
      setCaret(shown);
      if (i < chars.length) anim.timer = setTimeout(tick, step);
      else finish();
    };
    anim = { final: value, caret, timer: setTimeout(tick, step), done };
  };

  listen('beforeinput', (ev) => {
    finish();
    if (swallowCarry(ev)) return;
    const [s, e] = selection() ?? [el.value.length, el.value.length];
    before = { value: el.value, start: s, end: e };
  });
  // Moving the caret ends the chance to type over just-inserted separators.
  listen('keydown', (ev) => {
    finish(); // the next key goes after everything formaton is typing out
    if (/^(Arrow|Home$|End$|Page)/.test(ev.key)) pending = { text: '', at: -1 };
  });
  listen('mousedown', () => {
    finish();
    pending = { text: '', at: -1 };
  });
  listen('compositionstart', () => {
    composing = true;
  });
  listen('compositionend', () => {
    composing = false;
    handle('insertCompositionText');
  });
  listen('input', (ev) => {
    if (composing || (ev as InputEvent).isComposing) return;
    handle((ev as InputEvent).inputType ?? '');
  });
  listen('focus', () => {
    if (prefixOn && el.value === '') {
      const p = vx.prefix();
      if (p) {
        pending = { text: p, at: p.length };
        const animated = delay() > 0;
        if (!animated) {
          el.value = p;
          snapshot(p.length);
        }
        // A click places the caret after focus fires: start once that is done.
        setTimeout(() => {
          if (document.activeElement !== el) return;
          if (!animated && el.value === p) setCaret(p.length);
          if (animated && el.value === '') typeOut(p, p.length, 0, () => {});
        });
      }
    }
  });
  listen('blur', () => {
    finish();
    if (prefixOn && el.value !== '' && vx.unformat(el.value) === '') {
      el.value = '';
      snapshot(0);
    }
  });

  // An initial value that does not fit is repaired, not wiped.
  if (el.value !== '') {
    const r = vx.fix(el.value, { drop: true });
    if (r.value !== el.value) el.value = r.value;
  }
  snapshot(el.value.length);
  filled = isFilled(el.value);
  complete = isComplete(el.value);
  return binding;
}

/** Drops a keystroke that re-types what the previous field auto-completed. */
function swallowCarry(ev: InputEvent): boolean {
  if (!carry.text || Date.now() > carry.until || ev.inputType !== 'insertText' || !ev.data) {
    carry = { text: '', until: 0 };
    return false;
  }
  const typed = ev.data;
  const expected = carry.text.slice(0, typed.length);
  if (typed.toLowerCase() !== expected.toLowerCase()) {
    carry = { text: '', until: 0 };
    return false;
  }
  carry = { text: carry.text.slice(typed.length), until: carry.until };
  ev.preventDefault();
  return true;
}

function defaultPattern(el: FieldElement, type: string): string | null {
  if (type === 'email' && !(el as HTMLInputElement).multiple) return EMAIL_PATTERN;
  if (type === 'number') {
    const input = el as HTMLInputElement;
    const min = Number(input.min);
    const max = Number(input.max);
    const step = input.getAttribute('step');
    if (
      input.min !== '' &&
      input.max !== '' &&
      Number.isSafeInteger(min) &&
      Number.isSafeInteger(max) &&
      min >= 0 &&
      min <= max &&
      (step === null || step === '1')
    ) {
      return integerRangePattern(min, max);
    }
  }
  return null;
}

const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

/**
 * Moves focus to the next element in tab order, like pressing Tab (scripts
 * cannot press Tab for real). Returns the newly focused element, or null.
 */
export function focusNext(from: Element, root: ParentNode = document): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => isTabbable(e) || e === from);
  // Positive tabindex values come first, in ascending order; then DOM order.
  const ordered = all
    .map((e, i) => ({ e, i, t: e.tabIndex }))
    .sort((a, b) => {
      const ka = a.t > 0 ? a.t : Infinity;
      const kb = b.t > 0 ? b.t : Infinity;
      return ka !== kb ? ka - kb : a.i - b.i;
    })
    .map((x) => x.e);
  const at = ordered.indexOf(from as HTMLElement);
  for (let i = at + 1; i < ordered.length; i++) {
    const next = ordered[i];
    if (isRadioSkipped(next)) continue;
    next.focus();
    if (document.activeElement === next) return next;
  }
  return null;
}

function isTabbable(e: HTMLElement): boolean {
  if (e.tabIndex < 0) return false;
  if ((e as HTMLInputElement).disabled) return false;
  if (e instanceof HTMLInputElement && e.type === 'hidden') return false;
  if (e.closest('[inert], fieldset[disabled]')) return false;
  if (!e.getClientRects().length) return false;
  return getComputedStyle(e).visibility !== 'hidden';
}

/** Tab stops at one radio button per group: the checked one, or the first. */
function isRadioSkipped(e: HTMLElement): boolean {
  if (!(e instanceof HTMLInputElement) || e.type !== 'radio' || !e.name) return false;
  const scope = e.form ?? document;
  const group = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => r.name === e.name);
  const stop = group.find((r) => r.checked) ?? group[0];
  return stop !== e;
}
