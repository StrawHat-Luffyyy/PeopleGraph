// Copies non-TypeScript runtime assets (Cypher, and later Lua) from src/ into dist/,
// preserving paths, since tsc only emits .js. Run by `npm run build`.
import { cpSync } from 'node:fs';

const ASSET = /\.(cypher|lua)$/;

cpSync('src', 'dist', {
  recursive: true,
  filter: (source) => !/\.[a-z]+$/i.test(source) || ASSET.test(source),
});
