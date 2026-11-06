/** The pattern is not a valid regular expression. */
export class ValexSyntaxError extends SyntaxError {
  override name = 'ValexSyntaxError';
}

/**
 * The pattern is valid but uses a feature an automaton cannot model
 * (backreferences, lookaround, word boundaries) or is too large.
 * Callers should fall back to no assistance for such inputs.
 */
export class ValexUnsupportedError extends Error {
  override name = 'ValexUnsupportedError';
}
