/** The pattern is not a valid regular expression. */
export class FormatonSyntaxError extends SyntaxError {
  override name = 'FormatonSyntaxError';
}

/**
 * The pattern is valid but uses a feature an automaton cannot model
 * (backreferences, lookaround, word boundaries) or is too large.
 * Callers should fall back to no assistance for such inputs.
 */
export class FormatonUnsupportedError extends Error {
  override name = 'FormatonUnsupportedError';
}
