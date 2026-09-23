"""Read-only aggregation audit of default exact-text samples and source binding."""
import hashlib
import json
import math
from pathlib import Path
root = Path(__file__).resolve().parent
plan = json.loads((root / 'default-exact-preregistration.json').read_text())
report = json.loads((root / 'default-exact-text/report.json').read_text())
rows = [json.loads(line) for line in (root / 'default-exact-text/raw.jsonl').read_text().splitlines()]
queries = [row for row in rows if row['kind'] == 'default-exact-text']
batches = [row for row in rows if row['kind'] == 'inference']
reference = [json.loads(line) for line in (root / 'campaign-exact-e71627b/raw.jsonl').read_text().splitlines()]
reference = {(row['queryIndex'], row['repetition']): row for row in reference if row['kind'] == 'query'}
assert report['subjectCommit'] == plan['subjectCommit']
assert hashlib.sha256((root / 'default-exact-audit.mjs').read_bytes()).hexdigest() == plan['driverSha256'] == report['driverSha256']
assert len(queries) == report['count'] == plan['queryCount'] * plan['repetitions'] == 72
assert len({(row['queryIndex'], row['repetition']) for row in queries}) == 72
assert all(row['result']['mode'] == 'exact' for row in queries)
assert all(math.isfinite(row['elapsedMs']) and row['elapsedMs'] >= 0 for row in queries)
score_drift = 0
for row in queries:
    prior = reference[(row['queryIndex'], row['repetition'])]
    assert row['text'] == prior['text'] and row['expected'] == prior['relevant']
    assert [hit['entryId'] for hit in row['result']['hits']] == [hit['entryId'] for hit in prior['exact']['hits']]
    assert row['labels'] == [hit['label'] for hit in prior['exact']['hits']]
    score_drift = max(score_drift, *(abs(hit['cosine'] - old['cosine']) for hit, old in zip(row['result']['hits'], prior['exact']['hits'])))
values = sorted(row['elapsedMs'] for row in queries)
expected = {'minimum': values[0], 'median': values[len(values) // 2], 'p95': values[math.ceil(len(values) * .95) - 1], 'maximum': values[-1], 'mean': sum(values) / len(values)}
for key, value in expected.items():
    assert abs(report['timingsMs'][key] - value) < 1e-12
assert report['firstQueryMs'] == queries[0]['elapsedMs']
assert report['over2Ms'] == sum(row['elapsedMs'] > 2 for row in queries)
assert report['inferenceCalls'] == len(batches) == 78
assert sum(row['count'] for row in batches) == 175 + 72
assert all(row['count'] == 1 for row in batches[-72:])
recall = sum(sum(label in row['expected'] for label in row['labels']) / len(row['expected']) for row in queries) / len(queries)
assert recall == report['exactRecallAt3'] == .9375
assert report['sourceChangedDuringRun'] == ''
print(json.dumps({'format': 'aether.default-exact-text-aggregation-audit/1', 'passed': True, 'queries': len(queries), 'freshQueryInferenceCalls': 72, 'allRowsUsePublicExactDefault': True, 'sameRankingsAsIndependentExactBaseline': True, 'maximumScoreDifferenceFromBaseline': score_drift, 'firstRetained': True, 'over2Ms': report['over2Ms'], 'timingsMs': expected}, indent=2))
