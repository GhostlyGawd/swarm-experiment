/**
 * Regenerate the generated section of `docs/ROADMAP.md`.
 *
 *   node roadmap/render.ts          rewrite the file
 *   node roadmap/render.ts --check  fail if it would change
 *
 * The `--check` mode is what `test/roadmap.test.ts` relies on: it is how the
 * document is prevented from drifting away from the graph it claims to depict.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { renderCompletionSection, renderGraphSection, renderOrderingSection } from './graph.ts';

interface Section {
  readonly name: string;
  readonly render: () => string;
}

const SECTIONS: readonly Section[] = [
  { name: 'completion', render: renderCompletionSection },
  { name: 'graph', render: renderGraphSection },
  { name: 'ordering', render: renderOrderingSection },
];

export const ROADMAP_PATH = new URL('../docs/ROADMAP.md', import.meta.url).pathname;

/** Splice one generated section into a document, between its markers. */
export function splice(document: string, name: string, body: string): string {
  const start = `<!-- generated:${name} -->`;
  const end = `<!-- /generated:${name} -->`;
  const from = document.indexOf(start);
  const to = document.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`docs/ROADMAP.md is missing its ${start} … ${end} markers`);
  }
  return `${document.slice(0, from + start.length)}\n\n${body}\n${document.slice(to)}`;
}

/** The document as it should be, with every generated section refreshed. */
export function expected(): string {
  let out = readFileSync(ROADMAP_PATH, 'utf8');
  for (const section of SECTIONS) out = splice(out, section.name, section.render());
  return out;
}

function main(): void {
  const current = readFileSync(ROADMAP_PATH, 'utf8');
  const next = expected();
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error('docs/ROADMAP.md is out of date. Run: npm run roadmap');
      process.exitCode = 1;
      return;
    }
    console.log('docs/ROADMAP.md is up to date.');
    return;
  }
  writeFileSync(ROADMAP_PATH, next);
  console.log('docs/ROADMAP.md regenerated.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/roadmap\/)/, ''))) {
  main();
}
