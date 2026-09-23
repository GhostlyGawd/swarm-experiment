/** Actual Aether fixture, not a callback that asserts campaign success. */
import * as b from '../../../../src/tier1/build.ts';
import type { Ty } from '../../../../src/tier1/ast.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { LIVING_CAMPAIGN_PROFILE, type CampaignInput, type CampaignScenario, type CampaignStep, type LivingCampaignManifest } from '../../../../src/tier3/living-campaign.ts';

export function livingFixture(broken = false) {
  const symbols = new SymbolSpace('living-campaign-fixture'), registry = new CapabilityRegistry();
  const s = Object.fromEntries(['module', 'read', 'update', 'receive', 'resource', 'identity', 'state', 'n', 'order', 'sequence', 'allocation', 'checksum', 'ok'].map(name => [name, symbols.define(name)]));
  const STATE: Ty = { t: 'Record', name: typeName('type:campaign:state'), fields: [['value', b.Int]] };
  const read = b.fn({ symbol: s.read, params: [b.param(s.state, STATE)], returns: b.Int, body: b.block(b.ret(b.field(b.v(s.state), 'value'))) });
  const update = b.fn({ symbol: s.update, params: [b.param(s.state, STATE), b.param(s.n, b.Int)], returns: b.Unit,
    contract: b.contract({ modifies: [b.place(s.state, 'value')] }),
    body: b.block(b.assign(b.place(s.state, 'value'), b.add(broken ? b.v(s.n) : b.field(b.v(s.state), 'value'), b.int(1))), b.ret(b.unit())) });
  const receive = b.fn({ symbol: s.receive, params: [b.param(s.state, STATE), ...[s.order, s.sequence, s.allocation, s.checksum].map(symbol => b.param(symbol, b.Int))], returns: b.Bool,
    contract: b.contract({ modifies: [b.place(s.state, 'value')] }),
    body: b.block(b.if_(b.and(b.eq(b.v(s.checksum), b.mod(b.mul(b.v(s.sequence), b.int(17)), b.int(256))), b.and(b.le(b.v(s.allocation), b.int(4095)), b.gt(b.v(s.sequence), b.field(b.v(s.state), 'value')))),
      b.block(b.assign(b.place(s.state, 'value'), b.v(s.sequence)), b.ret(b.bool(true))), b.block(b.ret(b.bool(false))))) });
  const resource = b.fn({ symbol: s.resource, params: [b.param(s.ok, b.Bool)], returns: b.Bool, body: b.block(b.ret(b.v(s.ok))) });
  const identity = b.fn({ symbol: s.identity, params: [b.param(s.n, b.Int)], returns: b.Int, body: b.block(b.ret(b.v(s.n))) });
  const module = b.module_({ symbol: s.module, members: [read, update, receive, resource, identity], symbolTable: symbols.table() });
  const reference: CampaignInput = { tag: 'record', name: 'state' }, int = (value: number): CampaignInput => ({ tag: 'int', value: String(value) });
  const bool = (value: boolean): CampaignInput => ({ tag: 'bool', value });
  const setup = [{ name: 'state', ty: STATE, fields: { value: { tag: 'int' as const, value: '0' } } }];
  const check = (value: number): Extract<CampaignStep, { kind: 'call' }> => ({ kind: 'call', id: 'final-value', symbol: s.read, args: [reference], expect: int(value) });
  const callRead: CampaignStep = { kind: 'call', id: 'read', symbol: s.read, args: [reference], expect: null };
  const actor = (id: string) => ({ id, steps: [callRead, { kind: 'call' as const, id: 'write', symbol: s.update, args: [reference, { tag: 'slot' as const, actor: id, step: 'read' }], expect: { tag: 'null' as const } }] });
  const scheduler: CampaignScenario = { id: 'two-writers', kind: 'scheduler', scheduling: { mode: 'enumerate', cases: 6 }, variables: [], records: setup, actors: [actor('a'), actor('b')], checks: [check(2)], requiredCoverage: ['scheduler:switched', 'candidate-call'], allocationLimitBytes: 0 };
  const memory: CampaignScenario = { id: 'bounded-allocation', kind: 'resource', scheduling: { mode: 'seeded', cases: 3 }, variables: [], records: setup,
    actors: [{ id: 'allocator', steps: [
      { kind: 'reserve', id: 'first', bytes: 4096, expect: 'allocated' },
      { kind: 'reserve', id: 'excess', bytes: 1, expect: 'exhausted' },
      { kind: 'call', id: 'observe', symbol: s.resource, args: [{ tag: 'slot', actor: 'allocator', step: 'excess' }], expect: bool(false) },
      { kind: 'release', id: 'release', reservation: 'first' },
      { kind: 'reserve', id: 'reuse', bytes: 1, expect: 'allocated' },
    ] }], checks: [check(0)], requiredCoverage: ['resource:allocated', 'resource:exhausted', 'resource:released', 'candidate-call'], allocationLimitBytes: 4096 };
  const send = (id: string, sequence: number, mutation: Extract<CampaignStep, { kind: 'send' }>['mutation'] = 'none', order = 0): CampaignStep => ({ kind: 'send', id, event: { order, sequence, allocation: 1, checksum: sequence * 17 % 256 }, mutation });
  const deliver = (id: string, expected: boolean, ingress: Extract<CampaignStep, { kind: 'deliver' }>['ingress'] = 'delivered'): CampaignStep => ({ kind: 'deliver', id, symbol: s.receive, prefix: [reference], expect: bool(expected), ingress });
  const network: CampaignScenario = { id: 'faulted-json-network', kind: 'network', scheduling: { mode: 'seeded', cases: 3 }, variables: [], records: setup,
    actors: [{ id: 'transport', steps: [send('dup', 1, 'duplicate'), deliver('first', true), deliver('duplicate', false), send('bad-json', 2, 'malformed'), deliver('reject-json', false, 'malformed'), send('bad-integrity', 2, 'checksum'), deliver('reject-integrity', false), send('loss', 2, 'drop'), deliver('empty', false, 'empty'), send('good', 2), deliver('last', true)] }],
    checks: [check(2)], requiredCoverage: ['network:duplicate', 'network:malformed', 'network:checksum', 'network:drop', 'ingress:malformed', 'ingress:empty', 'ingress:delivered'], allocationLimitBytes: 0 };
  const ordering: CampaignScenario = { id: 'out-of-order-events', kind: 'event-order', scheduling: { mode: 'seeded', cases: 3 }, variables: [], records: setup,
    actors: [{ id: 'events', steps: [send('second-before-first', 2, 'none', 1), deliver('second', true), send('late-first', 1), deliver('first', false)] }], checks: [check(2)], requiredCoverage: ['event:reordered', 'event:ordered', 'candidate-call'], allocationLimitBytes: 0 };
  const manifest: LivingCampaignManifest = { format: LIVING_CAMPAIGN_PROFILE, candidateRoot: new GraphStore().intern(module), seed: '20260922', maxStepsPerCall: 1000, shrinkAttempts: 64, scenarios: [scheduler, memory, network, ordering] };
  return { module, registry, manifest, symbols: s, STATE };
}
