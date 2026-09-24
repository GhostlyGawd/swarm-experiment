import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readBudgetJournalHead } from '../../src/fabric/budget-journal-witness.ts';
import { openBridgeFixture, effectRequest, amount } from './resource-budget-bridge-fixture.ts';

const root = resolve(import.meta.dirname, '../..');
const fixtureUrl = pathToFileURL(join(root, 'test/tier2/resource-budget-bridge-fixture.ts')).href;
const serviceUrl = pathToFileURL(join(root, 'src/fabric/witness-service.ts')).href;
const repo = 'repo:budget-witness', deployment = 'deployment:budget-witness';
const authority = 'operator:budget-witness';

async function launch(config: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(root, 'src/fabric/witness-service-cli.ts'), '--config', config],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveReady, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`witness startup timeout: ${stderr}`)); }, 8000);
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdout!.on('data', chunk => {
      if (String(chunk).includes('witness service ready')) { clearTimeout(timer); resolveReady(child); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`witness exited ${code}: ${stderr}`)); });
  });
}
async function kill(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}
function setup(directory: string) {
  const key = randomBytes(32), keyFile = join(directory, 'witness.key'),
    socket = join(directory, 'witness.sock'), config = join(directory, 'witness.json');
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(config, encodeCanonical({ socketPath: socket,
    storageDir: join(directory, 'operator-witness-store'), keyFile,
    namespaces: [
      { kind: 'budget', authorityId: authority, repositoryId: repo, deploymentId: deployment,
        journalKind: 'ledger', journalId: 'bridge-budget' },
      { kind: 'budget', authorityId: authority, repositoryId: repo, deploymentId: deployment,
        journalKind: 'bridge', journalId: 'broker-budget' },
    ] }), { mode: 0o600 });
  const witnesses = () => {
    const client = createProcessWitnessClient({ socketPath: socket, key, timeoutMs: 1500 });
    return { ledgerWitness: client.budgetJournalWitness({ authorityId: authority,
      repositoryId: repo, deploymentId: deployment, journalKind: 'ledger', journalId: 'bridge-budget' }),
    bridgeWitness: client.budgetJournalWitness({ authorityId: authority,
      repositoryId: repo, deploymentId: deployment, journalKind: 'bridge', journalId: 'broker-budget' }) };
  };
  return { config, socket, keyFile, witnesses };
}
function childCode(directory: string, socket: string, keyFile: string,
  fault: 'ledger' | 'bridge', point: 'reserve' | 'charge' = 'reserve'): string {
  return `const {openBridgeFixture,effectRequest}=await import(${JSON.stringify(fixtureUrl)});
    const {createProcessWitnessClient}=await import(${JSON.stringify(serviceUrl)});
    const {readFileSync}=await import('node:fs');
    const client=createProcessWitnessClient({socketPath:${JSON.stringify(socket)},key:readFileSync(${JSON.stringify(keyFile)}),timeoutMs:1500});
    const common={authorityId:${JSON.stringify(authority)},repositoryId:${JSON.stringify(repo)},deploymentId:${JSON.stringify(deployment)}};
    const ledgerWitness=client.budgetJournalWitness({...common,journalKind:'ledger',journalId:'bridge-budget'});
    const bridgeWitness=client.budgetJournalWitness({...common,journalKind:'bridge',journalId:'broker-budget'});
    let writes=0;
    const f=openBridgeFixture(${JSON.stringify(directory)},{ledgerWitness,bridgeWitness,
      ${fault === 'ledger' ? `ledgerFault:phase=>{if(phase==='after-witness-commit'&&++writes===${point === 'reserve' ? 1 : 2})process.kill(process.pid,'SIGKILL');}`
        : `bridgeWitnessFault:()=>{if(++writes===${point === 'reserve' ? 1 : 3})process.kill(process.pid,'SIGKILL');}`}});
    ${point === 'reserve' ? 'f.bridge.reserve(effectRequest());' : 'f.broker.dispatch(effectRequest(),f.adapter);'}`;
}

test('external budget heads restore old local copies and reject same-revision edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-budget-witness-'));
  let service: ChildProcess | null = null;
  try {
    const operator = setup(directory); service = await launch(operator.config);
    const initial = openBridgeFixture(directory, operator.witnesses());
    initial.bridge.assertWitnessed();
    const files = ['ledger/journal.json', 'ledger/journal-witness-head.json',
      'bridge/bridge.json', 'bridge/journal-witness-head.json'];
    const before = files.map(path => readFileSync(join(directory, path)));
    const request = effectRequest();
    assert.equal(initial.broker.dispatch(request, initial.adapter).state, 'committed');
    assert.equal(initial.ledger.snapshot('budget-service').spent.tokens, '7');
    const ledgerHead = readBudgetJournalHead(operator.witnesses().ledgerWitness);
    const bridgeHead = readBudgetJournalHead(operator.witnesses().bridgeWitness);
    assert.ok(BigInt(ledgerHead.revision) >= 3n);
    assert.ok(BigInt(bridgeHead.revision) >= 4n);
    await kill(service); service = await launch(operator.config);
    files.forEach((path, index) => writeFileSync(join(directory, path), before[index]));
    const recovered = openBridgeFixture(directory, operator.witnesses());
    recovered.bridge.assertWitnessed();
    assert.equal(recovered.ledger.snapshot('budget-service').spent.tokens, '7');
    assert.equal(recovered.bridge.records()[0].settlementReceipt?.charged.tokens, '7');
    recovered.bridge.assertSettled(request, 'committed');
    assert.throws(() => recovered.bridge.assertSettled(request, 'not_committed'), /disposition mismatch/);
    assert.equal(recovered.broker.dispatch(request, recovered.adapter).state, 'committed');
    assert.equal(recovered.sink(request)?.commits, 1);
    unlinkSync(join(directory, 'ledger/journal.json'));
    unlinkSync(join(directory, 'bridge/bridge.json'));
    const fromDeletedCopies = openBridgeFixture(directory, operator.witnesses());
    assert.equal(fromDeletedCopies.ledger.snapshot('budget-service').spent.tokens, '7');
    assert.equal(fromDeletedCopies.bridge.records()[0].settlementReceipt?.charged.tokens, '7');
    const bridgeFile = join(directory, 'bridge/bridge.json');
    writeFileSync(bridgeFile, readFileSync(bridgeFile, 'utf8').replace('bridge-test', 'other-test'));
    assert.throws(() => recovered.bridge.records(), /same-revision budget journal tamper/);
    assert.throws(() => openBridgeFixture(directory, operator.witnesses()), /same-revision budget journal tamper/);
    writeFileSync(bridgeFile, bridgeHead.journal!);
    const ledgerFile = join(directory, 'ledger/journal.json');
    writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8').replace('aether.resource-journal/1', 'aether.resource-journal/2'));
    assert.throws(() => recovered.ledger.snapshot('budget-service'), /same-revision budget journal tamper/);
  } finally { await kill(service); rmSync(directory, { recursive: true, force: true }); }
});

test('budget witness outage refuses read, reserve and fresh reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-budget-witness-outage-'));
  let service: ChildProcess | null = null;
  try {
    const operator = setup(directory); service = await launch(operator.config);
    const f = openBridgeFixture(directory, operator.witnesses());
    assert.throws(() => createProcessWitnessClient({ socketPath: operator.socket,
      key: readFileSync(operator.keyFile), timeoutMs: 1500 }).budgetJournalWitness({
      authorityId: authority, repositoryId: repo, deploymentId: deployment,
      journalKind: 'ledger', journalId: 'other-budget' }), /witness DENIED/);
    assert.equal(f.broker.dispatch(effectRequest(), f.adapter).state, 'committed');
    f.bridge.assertSettled(effectRequest(), 'committed');
    await kill(service); service = null;
    assert.throws(() => f.ledger.snapshot('budget-service'), /uncertain witness response/);
    assert.throws(() => f.bridge.assertWitnessed(), /uncertain witness response/);
    assert.throws(() => f.bridge.assertSettled(effectRequest(), 'committed'), /uncertain witness response/);
    assert.throws(() => f.bridge.reserve(effectRequest()), /uncertain witness response/);
    assert.throws(() => openBridgeFixture(directory, operator.witnesses()), /uncertain witness response/);
  } finally { await kill(service); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL after ledger or bridge witness CAS restores a reservation before retry', async () => {
  for (const fault of ['ledger', 'bridge'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-budget-witness-crash-'));
    let service: ChildProcess | null = null;
    try {
      const operator = setup(directory); service = await launch(operator.config);
      openBridgeFixture(directory, operator.witnesses());
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
        childCode(directory, operator.socket, operator.keyFile, fault)], { cwd: root, encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const recovered = openBridgeFixture(directory, operator.witnesses());
      assert.equal(recovered.bridge.reserve(effectRequest()), true);
      assert.deepEqual(encodeCanonical(recovered.ledger.snapshot('budget-service').inflight), encodeCanonical(amount(10)));
      const result = recovered.broker.dispatch(effectRequest(), recovered.adapter);
      assert.equal(result.state, 'committed');
      assert.deepEqual(encodeCanonical(recovered.ledger.snapshot('budget-service').spent), encodeCanonical(amount(7)));
      assert.equal(recovered.sink(effectRequest())?.commits, 1);
      assert.equal(recovered.bridge.reserve(effectRequest()), false);
    } finally { await kill(service); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('SIGKILL after witnessed charge intent or ledger charge never bills twice', async () => {
  for (const fault of ['ledger', 'bridge'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-budget-witness-charge-'));
    let service: ChildProcess | null = null;
    try {
      const operator = setup(directory); service = await launch(operator.config);
      openBridgeFixture(directory, operator.witnesses());
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
        childCode(directory, operator.socket, operator.keyFile, fault, 'charge')],
      { cwd: root, encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const recovered = openBridgeFixture(directory, operator.witnesses());
      recovered.broker.recoverDeadWriter();
      const result = recovered.broker.reconcile(effectRequest(), recovered.adapter);
      assert.equal(result.state, 'committed');
      assert.equal(recovered.sink(effectRequest())?.commits, 1);
      assert.deepEqual(encodeCanonical(recovered.ledger.snapshot('budget-service').spent), encodeCanonical(amount(7)));
      recovered.bridge.assertSettled(effectRequest(), 'committed');
      const sequence = recovered.ledger.snapshot('budget-service').sequence;
      assert.equal(recovered.broker.reconcile(effectRequest(), recovered.adapter).state, 'committed');
      assert.equal(recovered.ledger.snapshot('budget-service').sequence, sequence);
    } finally { await kill(service); rmSync(directory, { recursive: true, force: true }); }
  }
});
