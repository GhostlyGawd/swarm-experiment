#!/usr/bin/env node
/** Run with node --experimental-strip-types. Dependencies live in the explicit
 * isolated tool directory, never installed into the Aether package. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { HybridGraphIndex, embeddingModelDigest, canonicalVector } from '../../../../src/tier1/semantic-index.ts';
import { DurableGraphStore } from '../../../../src/tier1/durable-store.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LABELED_QUERIES, retrievalCorpus } from './corpus.ts';

const toolsDirectory = process.argv[2] ?? '/tmp/aether-t104-embedding-tools';
const outputDirectory = resolve(process.argv[3] ?? 'roadmap/v4/research/retrieval/results/m4-pro-campaign-01');
const cacheDirectory = resolve(process.argv[4] ?? '/tmp/aether-t104-model-cache');
if (existsSync(outputDirectory)) throw new Error('refusing to overwrite retained campaign output');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const preregistrationPath = 'roadmap/v4/research/retrieval/preregistration-v1.json';
const prereg = JSON.parse(readFileSync(preregistrationPath, 'utf8'));
if (sha(readFileSync(prereg.corpusFile)) !== prereg.corpusSha256 || JSON.stringify(prereg.queries) !== JSON.stringify(LABELED_QUERIES)) throw new Error('preregistered corpus/labels changed');
const packageVersion = JSON.parse(readFileSync(join(toolsDirectory, 'node_modules/@huggingface/transformers/package.json'))).version;
if (`@huggingface/transformers@${packageVersion}` !== prereg.model.library) throw new Error('tool version differs from preregistration');
const fileInventory = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name); return entry.isDirectory() ? fileInventory(path) : [{ path, bytes: statSync(path).size, sha256: sha(readFileSync(path)) }];
}).sort((a, b) => a.path.localeCompare(b.path));
const sourcePaths = ['src/tier1/semantic-index.ts', 'src/tier1/embedding-input.ts', 'src/tier1/durable-store.ts', 'src/fabric/encoding.ts', 'src/fabric/identity.ts', 'src/fabric/journal-lock.ts', prereg.corpusFile, 'roadmap/v4/research/retrieval/run-campaign.mjs'];
const sources = sourcePaths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
mkdirSync(outputDirectory, { recursive: true });
const write = (name, value) => writeFileSync(join(outputDirectory, name), JSON.stringify(value, null, 2) + '\n');
write('admission.json', { format: 'aether.retrieval-campaign-admission/1', startedAt: new Date().toISOString(), preregistrationSha256: sha(readFileSync(preregistrationPath)), sources, gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), gitStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }), hardware: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, platform: os.platform(), release: os.release(), arch: os.arch(), totalMemory: os.totalmem(), load: os.loadavg() }, node: process.version, packages: JSON.parse(readFileSync(join(toolsDirectory, 'package-lock.json'), 'utf8')), scope: prereg.evaluation });
const raw = value => appendFileSync(join(outputDirectory, 'raw.jsonl'), JSON.stringify(value) + '\n');
const milliseconds = start => Number(process.hrtime.bigint() - start) / 1e6;
try {
  const cachePresentAtStart = existsSync(cacheDirectory) && readdirSync(cacheDirectory).length > 0;
  const initStart = process.hrtime.bigint();
  const { AutoTokenizer, AutoModel, env, mean_pooling } = await import(pathToFileURL(join(toolsDirectory, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
  env.cacheDir = cacheDirectory;
  const tokenizer = await AutoTokenizer.from_pretrained(prereg.model.name, { revision: prereg.model.revision });
  const model = await AutoModel.from_pretrained(prereg.model.name, { revision: prereg.model.revision, dtype: 'fp32', device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
  const initializeMs = milliseconds(initStart), artifacts = fileInventory(cacheDirectory);
  if (!artifacts.some(file => file.path.endsWith('model.onnx'))) throw new Error('missing pinned ONNX artifact in cache inventory');
  const tokenizerArtifacts = artifacts.filter(file => /tokenizer|vocab|special_tokens/.test(file.path));
  const relative = artifacts.map(file => ({ ...file, path: file.path.slice(cacheDirectory.length + 1) }));
  const profile = { format: 'aether.embedding-model/1', name: prereg.model.name, revision: prereg.model.revision, artifactDigest: domainDigest('aether.embedding-artifact/1', relative), tokenizerDigest: domainDigest('aether.embedding-tokenizer/1', tokenizerArtifacts.map(file => ({ ...file, path: file.path.slice(cacheDirectory.length + 1) }))), dimensions: 384, pooling: 'mean', normalization: 'l2', dtype: 'fp32', maxTokens: 256, runtime: { name: '@huggingface/transformers', version: packageVersion } };
  write('model.json', { profile, modelDigest: embeddingModelDigest(profile), initializeMs, artifacts: relative, initializationMayIncludeDownloads: true, cachePresentAtStart, firstInferenceNotExcluded: true });
  let inferenceCalls = 0, inferredInputs = 0, truncatedInputs = 0;
  const provider = { modelDigest: embeddingModelDigest(profile), async embed(texts) {
    const start = process.hrtime.bigint();
    const lengths = texts.map(text => Number(tokenizer(text, { truncation: false }).input_ids.dims[1]));
    const encoded = tokenizer(texts, { padding: true, truncation: true, max_length: 256 });
    const result = await model(encoded); const features = result.last_hidden_state ?? result.token_embeddings;
    if (!features || features.dims[2] !== 384) throw new Error('unexpected model output shape');
    const vectors = mean_pooling(features, encoded.attention_mask).normalize(2, -1).tolist();
    inferenceCalls++; inferredInputs += texts.length; truncatedInputs += lengths.filter(length => length > 256).length;
    raw({ kind: 'embedding-batch', call: inferenceCalls, count: texts.length, tokenLengths: lengths, paddedShape: encoded.input_ids.dims, elapsedMs: milliseconds(start), inputDigests: texts.map(text => sha(Buffer.from(text))), vectors: vectors.map(vector => canonicalVector(vector, 384)), rss: process.memoryUsage().rss, load: os.loadavg() });
    return vectors;
  } };
  const corpus = retrievalCorpus();
  const store = new DurableGraphStore({ directory: join(outputDirectory, 'cas') });
  const root = store.intern(corpus.module, { leaseId: 'campaign-source' });
  const scope = { root, context: { specRoot: null, text: 'Typed utility library implemented as immutable abstract syntax trees.' } };
  const indexOptions = { directory: join(outputDirectory, 'index'), store, model: profile, lsh: { format: prereg.algorithm.format, seed: prereg.algorithm.seed, tables: prereg.algorithm.tables, bits: prereg.algorithm.bits } };
  const index = new HybridGraphIndex(indexOptions);
  const labelForRef = new Map(corpus.declarations.map(item => [store.intern(item.term, { leaseId: 'campaign-labels' }), item.label]));
  const backfillStart = process.hrtime.bigint(); const backfill = await index.backfill([scope], provider); const backfillMs = milliseconds(backfillStart);
  write('inputs.json', { root, labels: [...labelForRef], inputs: index.entries() });
  const coldStart = process.hrtime.bigint(); const reopened = new HybridGraphIndex(indexOptions); const coldOpenMs = milliseconds(coldStart);
  const initialSnapshot = reopened.snapshot, metrics = [], labelHits = hits => hits.map(hit => ({ ...hit, label: labelForRef.get(hit.subject) ?? null }));
  for (let queryIndex = 0; queryIndex < LABELED_QUERIES.length; queryIndex++) {
    const query = LABELED_QUERIES[queryIndex];
    for (let repetition = 0; repetition < prereg.repetitionsPerTextQuery; repetition++) {
      const vector = await reopened.embedQuery(query.text, provider);
      const common = { snapshot: initialSnapshot, k: prereg.k, filter: prereg.filter, probes: prereg.algorithm.probes };
      const exactStart = process.hrtime.bigint(); const exact = reopened.query({ ...common, embedding: vector, mode: 'exact' }); const exactMs = milliseconds(exactStart);
      const annStart = process.hrtime.bigint(); const approximate = reopened.query({ ...common, embedding: vector, mode: 'lsh' }); const vectorReadyMs = milliseconds(annStart);
      const textStart = process.hrtime.bigint(); const textResult = await reopened.queryText(query.text, provider, { ...common, mode: 'lsh' }); const textQueryMs = milliseconds(textStart);
      raw({ kind: 'completed-query-stages', queryIndex, repetition, exact, approximate, textResult, exactMs, vectorReadyMs, textQueryMs });
      const threshold = reopened.query({ ...common, embedding: vector, mode: 'exact', minimumCosine: 0.85 });
      const exactLabels = labelHits(exact.hits), annLabels = labelHits(approximate.hits), relevant = new Set(query.relevant);
      const recall = hits => hits.filter(hit => relevant.has(hit.label)).length / relevant.size;
      const reciprocalRank = hits => { const position = hits.findIndex(hit => relevant.has(hit.label)); return position < 0 ? 0 : 1 / (position + 1); };
      const exactIds = new Set(exact.hits.map(hit => hit.entryId));
      const result = { kind: 'query', queryIndex, repetition, text: query.text, relevant: query.relevant, exact: { ...exact, hits: exactLabels }, approximate: { ...approximate, hits: annLabels }, textQueryHits: labelHits(textResult.hits), threshold085Hits: labelHits(threshold.hits), exactMs, vectorReadyMs, textQueryMs, exactRecall: recall(exactLabels), annRecall: recall(annLabels), exactReciprocalRank: reciprocalRank(exactLabels), annReciprocalRank: reciprocalRank(annLabels), annRecallAgainstExact: approximate.hits.filter(hit => exactIds.has(hit.entryId)).length / exactIds.size, filterViolations: [...exactLabels, ...annLabels].filter(hit => !hit.label || ['logMessage', 'auditPayment', 'logRateLimit', 'persistText'].includes(hit.label)).length };
      metrics.push(result); raw(result);
    }
  }
  const originalDecl = corpus.declarations[0].term, originalRef = store.intern(originalDecl, { leaseId: 'campaign-labels' });
  const previousEntry = reopened.entries().find(entry => entry.subject === originalRef);
  corpus.symbols.rename(originalDecl.symbol, 'addPurchaseServiceCharge');
  const changed = { ...corpus.module, symbolTable: corpus.symbols.table() }, changedRoot = store.intern(changed, { leaseId: 'campaign-source' });
  const updateStart = process.hrtime.bigint(); const update = await reopened.backfill([{ ...scope, root: changedRoot }], provider); const updateMs = milliseconds(updateStart);
  if (store.intern(originalDecl, { leaseId: 'campaign-labels' }) !== originalRef || changedRoot === root) throw new Error('rename violated executable/context identity test');
  let staleRejected = false; try { reopened.query({ snapshot: initialSnapshot, embedding: await reopened.embedQuery(LABELED_QUERIES[0].text, provider), k: 1 }); } catch (error) { if (!String(error).includes('stale index generation')) throw error; staleRejected = true; }
  if (!staleRejected) throw new Error('old index generation accepted');
  let staleInputRejected = false; try { reopened.vectorFor(previousEntry.entryId, previousEntry.inputDigest); } catch (error) { if (!String(error).includes('stale or missing embedding input')) throw error; staleInputRejected = true; }
  if (!staleInputRejected || update.reused !== 0) throw new Error('renamed symbol context reused stale embedding identity');
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, minimum: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], maximum: sorted.at(-1), mean: mean(values) }; };
  const indexFiles = fileInventory(join(outputDirectory, 'index')), casFiles = fileInventory(join(outputDirectory, 'cas'));
  const report = { format: 'aether.retrieval-campaign-result/1', completedAt: new Date().toISOString(), scope: prereg.evaluation, profile, declarations: corpus.declarations.length, indexedInputs: index.entries().length, labeledQueries: LABELED_QUERIES.length, repetitions: prereg.repetitionsPerTextQuery, inferenceCalls, inferredInputs, truncatedInputs, initializeMs, coldOpenMs, backfill: { ...backfill, elapsedMs: backfillMs }, update: { ...update, elapsedMs: updateMs, staleRejected, staleInputRejected, originalExecutableRef: originalRef, oldScopeRoot: root, newScopeRoot: changedRoot }, quality: { exactRecallAt3: mean(metrics.map(row => row.exactRecall)), annRecallAt3: mean(metrics.map(row => row.annRecall)), exactMeanReciprocalRank: mean(metrics.map(row => row.exactReciprocalRank)), annMeanReciprocalRank: mean(metrics.map(row => row.annReciprocalRank)), annRecallAgainstExactTop3: mean(metrics.map(row => row.annRecallAgainstExact)), filterViolations: metrics.reduce((sum, row) => sum + row.filterViolations, 0), candidates: summary(metrics.map(row => row.approximate.candidates)), cosine085ResultCounts: metrics.map(row => row.threshold085Hits.length) }, timingsMs: { warmExactVectorReady: summary(metrics.map(row => row.exactMs)), warmLshVectorReady: summary(metrics.map(row => row.vectorReadyMs)), fullTextQueryIncludingInference: summary(metrics.map(row => row.textQueryMs)) }, storage: { indexBytes: indexFiles.reduce((sum, file) => sum + file.bytes, 0), casBytes: casFiles.reduce((sum, file) => sum + file.bytes, 0), downloadedModelBytes: artifacts.reduce((sum, file) => sum + file.bytes, 0), retainedHistoricalGenerations: 3, vectorPayloadBytesPerInput: 384 * 4, indexFiles: indexFiles.map(file => ({ ...file, path: file.path.slice(outputDirectory.length + 1) })), casFileCount: casFiles.length }, process: { rss: process.memoryUsage().rss, load: os.loadavg() }, sourceChangesDuringRun: sources.filter(file => sha(readFileSync(file.path)) !== file.sha256) };
  write('report.json', report); await model.dispose(); console.log(JSON.stringify({ outputDirectory, indexedInputs: report.indexedInputs, quality: report.quality, timingsMs: report.timingsMs, storageBytes: report.storage.indexBytes }, null, 2));
} catch (error) { write('failure.json', { format: 'aether.retrieval-campaign-failure/1', at: new Date().toISOString(), error: String(error), stack: error.stack }); throw error; }
