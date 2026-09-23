#!/usr/bin/env node
/** Independent scoring/aggregation audit; never opens a mutable CAS/index. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { domainDigest } from '../../../../src/fabric/identity.ts';
const directory = resolve(process.argv[2] ?? 'roadmap/v4/research/retrieval/results/m4-pro-campaign-02');
const modelCache = process.argv[3];
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = read('report.json'), admission = read('admission.json'), model = read('model.json'), inputs = read('inputs.json');
const registration = JSON.parse(readFileSync('roadmap/v4/research/retrieval/preregistration-v1.json', 'utf8'));
assert.equal(sha(readFileSync('roadmap/v4/research/retrieval/preregistration-v1.json')), admission.preregistrationSha256);
assert.equal(sha(readFileSync(registration.corpusFile)), registration.corpusSha256);
const raw = readFileSync(join(directory, 'raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const queries = raw.filter(row => row.kind === 'query'), batches = raw.filter(row => row.kind === 'embedding-batch');
assert.equal(queries.length, registration.queries.length * registration.repetitionsPerTextQuery);
assert.equal(new Set(queries.map(row => `${row.queryIndex}:${row.repetition}`)).size, queries.length);
assert.equal(raw.filter(row => row.kind === 'completed-query-stages').length, queries.length);
const original = JSON.parse(readFileSync(join(directory, 'index/generations', report.backfill.snapshot.split(':').at(-1) + '.json'), 'utf8'));
assert.equal(domainDigest('aether.hybrid-generation/1', original), report.backfill.snapshot);
assert.deepEqual(original.records.map(record => record.input), inputs.inputs);
const labels = new Map(inputs.labels);
const vectors = new Map();
const unpack = packed => {
  assert.equal(packed.format, 'aether.float32-vector/1'); assert.equal(packed.dimensions, 384);
  const bytes = Buffer.from(packed.bytes, 'base64'); assert.equal(bytes.toString('base64'), packed.bytes); assert.equal(bytes.length, 1536);
  const values = Array.from({ length: 384 }, (_, i) => bytes.readFloatLE(i * 4)); assert.ok(values.every(Number.isFinite)); assert.ok(Math.abs(Math.sqrt(values.reduce((sum, x) => sum + x * x, 0)) - 1) < 0.00001); return values;
};
for (const record of original.records) vectors.set(record.input.entryId, unpack(record.vector));
const inferred = new Map(); let maximumRepeatedInputComponentDrift = 0;
for (const batch of batches) {
  assert.equal(batch.inputDigests.length, batch.count); assert.equal(batch.vectors.length, batch.count); assert.ok(batch.elapsedMs >= 0); assert.ok(batch.paddedShape[1] <= 256);
  batch.inputDigests.forEach((digest, i) => { const vector = batch.vectors[i]; unpack(vector); if (inferred.has(digest)) { const prior = unpack(inferred.get(digest)), current = unpack(vector); maximumRepeatedInputComponentDrift = Math.max(maximumRepeatedInputComponentDrift, ...prior.map((value, index) => Math.abs(value - current[index]))); } else inferred.set(digest, vector); });
}
const initialInference = [];
for (const batch of batches) {
  if (initialInference.length >= report.backfill.embedded) break;
  batch.inputDigests.forEach((digest, index) => initialInference.push({ digest, vector: batch.vectors[index] }));
}
assert.equal(report.backfill.reused, 0); assert.equal(initialInference.length, original.records.length);
original.records.forEach((record, index) => {
  assert.equal(initialInference[index].digest, sha(Buffer.from(record.input.text)), 'persisted input does not match its actual initial inference input');
  assert.equal(initialInference[index].vector.bytes, record.vector.bytes, 'persisted vector does not match its actual initial inference output');
});
const dotScore = (a, b) => { let dot = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))); };
const scored = []; const readyVectors = new Map(), seenBatches = [];
for (const row of raw) {
  if (row.kind === 'embedding-batch') seenBatches.push(row);
  if (row.kind === 'completed-query-stages') { const pair = seenBatches.slice(-2); assert.equal(pair.length, 2); const queryText = registration.queries[row.queryIndex].text; for (const batch of pair) { assert.equal(batch.count, 1); assert.equal(batch.inputDigests[0], sha(Buffer.from(queryText))); } readyVectors.set(`${row.queryIndex}:${row.repetition}`, pair[0].vectors[0]); }
}
for (const row of queries) {
  const label = registration.queries[row.queryIndex]; assert.equal(row.text, label.text); assert.deepEqual(row.relevant, label.relevant);
  const vector = unpack(readyVectors.get(`${row.queryIndex}:${row.repetition}`));
  const exact = original.records.filter(record => record.input.structure.kind === 'FunctionDecl' && record.input.structure.declaredPurity === 'pure').map(record => ({ id: record.input.entryId, subject: record.input.subject, cosine: dotScore(vector, vectors.get(record.input.entryId)) })).sort((a, b) => b.cosine - a.cosine || (a.id < b.id ? -1 : 1)).slice(0, registration.k);
  assert.deepEqual(row.exact.hits.map(hit => hit.entryId), exact.map(hit => hit.id));
  row.exact.hits.forEach((hit, i) => { assert.ok(Math.abs(hit.cosine - exact[i].cosine) < 1e-12); assert.equal(hit.label, labels.get(hit.subject)); });
  for (const hit of row.approximate.hits) { const record = original.records.find(record => record.input.entryId === hit.entryId); assert.equal(record.input.structure.kind, 'FunctionDecl'); assert.equal(record.input.structure.declaredPurity, 'pure'); assert.equal(hit.label, labels.get(hit.subject)); assert.ok(Math.abs(hit.cosine - dotScore(vector, vectors.get(hit.entryId))) < 1e-12); }
  const recall = hits => hits.filter(hit => label.relevant.includes(labels.get(hit.subject))).length / label.relevant.length;
  const rank = hits => { const first = hits.findIndex(hit => label.relevant.includes(labels.get(hit.subject))); return first < 0 ? 0 : 1 / (first + 1); };
  const exactIds = new Set(exact.map(hit => hit.id));
  const entry = { exactRecall: recall(row.exact.hits), annRecall: recall(row.approximate.hits), exactMeanReciprocalRank: rank(row.exact.hits), annMeanReciprocalRank: rank(row.approximate.hits), annRecallAgainstExactTop3: row.approximate.hits.filter(hit => exactIds.has(hit.entryId)).length / exactIds.size };
  assert.equal(entry.exactRecall, row.exactRecall); assert.equal(entry.annRecall, row.annRecall); assert.equal(row.filterViolations, 0); scored.push(entry);
  assert.ok(row.exactMs >= 0 && row.vectorReadyMs >= 0 && row.textQueryMs >= 0);
  assert.deepEqual(row.threshold085Hits.map(hit => hit.entryId), exact.filter(hit => hit.cosine >= 0.85).map(hit => hit.id));
}
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
for (const [metric, field] of [['exactRecallAt3', 'exactRecall'], ['annRecallAt3', 'annRecall'], ['exactMeanReciprocalRank', 'exactMeanReciprocalRank'], ['annMeanReciprocalRank', 'annMeanReciprocalRank'], ['annRecallAgainstExactTop3', 'annRecallAgainstExactTop3']]) assert.ok(Math.abs(report.quality[metric] - mean(scored.map(row => row[field]))) < 1e-14);
for (const [metric, field] of [['warmExactVectorReady', 'exactMs'], ['warmLshVectorReady', 'vectorReadyMs'], ['fullTextQueryIncludingInference', 'textQueryMs']]) {
  const values = queries.map(row => row[field]).sort((a, b) => a - b), actual = report.timingsMs[metric]; assert.equal(actual.count, values.length); assert.equal(actual.median, values[Math.floor(values.length / 2)]); assert.equal(actual.maximum, values.at(-1)); assert.equal(actual.p95, values[Math.ceil(values.length * .95) - 1]);
}
assert.equal(report.inferenceCalls, batches.length); assert.equal(report.inferredInputs, batches.reduce((sum, batch) => sum + batch.count, 0));
assert.equal(report.truncatedInputs, batches.flatMap(batch => batch.tokenLengths).filter(length => length > 256).length);
assert.equal(report.quality.filterViolations, 0); assert.equal(report.storage.indexBytes, report.storage.indexFiles.reduce((sum, file) => sum + file.bytes, 0));
for (const file of report.storage.indexFiles) { const bytes = readFileSync(join(directory, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256); }
const inventory = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? inventory(join(path, entry.name)) : [{ bytes: statSync(join(path, entry.name)).size }]);
assert.equal(inventory(join(directory, 'cas')).reduce((sum, file) => sum + file.bytes, 0), report.storage.casBytes);
assert.equal(domainDigest('aether.embedding-artifact/1', model.artifacts), model.profile.artifactDigest);
if (modelCache) for (const file of model.artifacts) { const bytes = readFileSync(join(modelCache, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256); }
const capture = read('source-capture.json');
for (const source of capture.sources) { const admitted = admission.sources.find(item => item.path === source.path); assert.equal(admitted.sha256, source.sha256); assert.equal(sha(readFileSync(join(directory, source.snapshotPath))), source.sha256); }
assert.deepEqual(report.sourceChangesDuringRun, []);
console.log(JSON.stringify({ format: 'aether.retrieval-evidence-audit/1', passed: true, auditorSha256: sha(readFileSync(new URL(import.meta.url))), scoredQueries: queries.length, embeddingBatches: batches.length, maximumRepeatedInputComponentDrift, modelArtifactBytesChecked: modelCache ? report.storage.downloadedModelBytes : null, sourceSnapshotsChecked: capture.sources.length, persistedInferenceLinksChecked: initialInference.length, exactRecallAt3: report.quality.exactRecallAt3, approximateRecallAt3: report.quality.annRecallAt3 }, null, 2));
