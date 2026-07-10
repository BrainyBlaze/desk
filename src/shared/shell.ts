// Single source of truth for POSIX shell single-quoting.
//
// Wraps a value in single quotes and escapes any embedded single quote via the
// standard `'\''` idiom, so the result is a safe, literal shell word — `$(...)`,
// backticks, spaces, and quotes inside `value` are never interpreted. Previously
// this function was copy-pasted byte-for-byte across four modules; a divergence
// (or a call site that forgot to use it) is exactly how a shell-injection bug
// slips in, so it lives in one audited place.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
