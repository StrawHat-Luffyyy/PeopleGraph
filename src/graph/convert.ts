import neo4j from 'neo4j-driver';

/**
 * Converts a driver Integer (or a plain number) to a JS number at the repository
 * boundary, so nothing above src/graph/ sees driver types. Throws if the value would
 * lose precision rather than silently returning a wrong count.
 */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (neo4j.isInt(value)) {
    if (!neo4j.integer.inSafeRange(value)) throw new RangeError('integer out of safe range');
    return value.toNumber();
  }
  throw new TypeError(`expected an integer, got ${typeof value}`);
}

/**
 * Converts a driver DateTime to its ISO-8601 string. Keeps full nanosecond precision
 * (unlike a JS Date), which keyset cursors rely on to round-trip exactly.
 */
export function toIsoString(value: unknown): string {
  if (neo4j.isDateTime(value)) return value.toString();
  throw new TypeError('expected a datetime');
}
