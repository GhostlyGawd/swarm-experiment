import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { AetherRepository } from '../../src/tier1/repository.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { projectDiff } from '../../src/projection/diff.ts';
import { ProjectionLanguageServer } from '../../src/projection/lsp.ts';
import { projectPython } from '../../src/projection/python.ts';
import { projectRust } from '../../src/projection/rust.ts';

const directories: string[] = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('H1/H2: Rust and Python projections expose the same semantic functions', () => {
  const ex = buildLedgerExample('multilang-projection');
  const rust = projectRust(ex.module, ex.syms);
  const python = projectPython(ex.module, ex.syms);
  assert.match(rust, /fn transfer\(/);
  assert.match(rust, /fn feeFor\(/);
  assert.match(python, /def transfer\(/);
  assert.match(python, /def feeFor\(/);
});

test('H4: structural diff projection renders only changed graph paths', () => {
  const ex = buildLedgerExample('diff-projection');
  const store = new GraphStore();
  const before = store.intern(ex.module);
  const path = store.findPath(before, (node) => node.kind === 'Lit' && node.value === 100n)!;
  const after = store.replaceAt(before, path, store.intern(b.int(50)));
  const diff = projectDiff(store, before, after, ex.syms);
  assert.match(diff, /changed/);
  assert.match(diff, /50n/);
  assert.doesNotMatch(diff, /function transfer/);
});

test('H3: projection language server applies a text edit through a branch CAS', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-lsp-'));
  directories.push(directory);
  const ex = buildLedgerExample('lsp-projection');
  const repository = new AetherRepository(directory);
  const root = repository.store.intern(ex.module);
  repository.commit('main', root, { timestamp: 1, message: 'initial' });
  const server = new ProjectionLanguageServer(repository, ex.syms);
  const opened = server.open('main');
  const edited = opened.text.replace('return gross / 100n;', 'return gross / 50n;');
  assert.notEqual(edited, opened.text);
  const applied = server.apply('main', edited, opened.commit);
  assert.notEqual(applied.commit, opened.commit);
  assert.match(applied.text, /return gross \/ 50n;/);
  const initialized = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok('result' in initialized);
});
