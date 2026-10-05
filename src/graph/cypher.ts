import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

/**
 * Loads `src/graph/cypher/<name>.cypher` (copied to dist/ by the build). Read once, then
 * cached. Names are fixed literals in repositories, never derived from input.
 */
export function loadCypher(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`./cypher/${name}.cypher`, import.meta.url), 'utf8');
    cache.set(name, text);
  }
  return text;
}
