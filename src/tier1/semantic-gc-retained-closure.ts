/** A retention reference names one complete executable context. Additional
 * FunctionDecl roots under that reference are its exact dependency closure.
 * Audit-only roots are protected physically but never made executable here. */
import { exactObject, identifier } from '../fabric/encoding.ts';
import { validateDigest } from '../fabric/identity.ts';
import { typecheck } from '../tier2/typecheck.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { children, type Term } from './ast.ts';
import type { DurableGraphStore } from './durable-store.ts';
import type { CapabilityName, NodeRef, SymbolId } from './ids.ts';
import type { SemanticRetention } from './semantic-gc.ts';
import { GraphStore } from './store.ts';

type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
type Module = Extract<Term, { kind: 'Module' }>;
function* walk(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* walk(child); }
const dynamic = new Set(['Import', 'Lambda', 'Apply', 'Spawn', 'Await', 'SeqMap', 'SeqFold']);

/** Return every capability that a retained task, replay or unstable replica
 * could use, even when the call is in a separately pinned dependency. */
export function retainedExecutableCapabilities(store: DurableGraphStore, registry: CapabilityRegistry,
  retained: readonly SemanticRetention[]): ReadonlySet<CapabilityName> {
  const groups = new Map<string, { modules: Map<NodeRef, Module>; dependencies: Map<SymbolId, { root: NodeRef; declaration: Decl }> }>();
  for (const pin of retained) {
    exactObject(pin, ['kind', 'reference', 'root']); identifier(pin.reference); validateDigest(pin.root, 'ast');
    if (!['audit', 'replay', 'active-task', 'unstable-replication'].includes(pin.kind)) throw new Error('unknown retention kind');
    const term = store.hydrate(pin.root);
    if (new GraphStore().intern(term) !== pin.root) throw new Error('retained AST content mismatch');
    if (pin.kind === 'audit') continue;
    const group = groups.get(pin.reference) ?? { modules: new Map(), dependencies: new Map() };
    groups.set(pin.reference, group);
    if (term.kind === 'Module') group.modules.set(pin.root, term);
    else if (term.kind === 'FunctionDecl') {
      const old = group.dependencies.get(term.symbol);
      if (old && old.root !== pin.root) throw new Error('conflicting retained dependency declaration');
      group.dependencies.set(term.symbol, { root: pin.root, declaration: term });
    } else throw new Error('executable retention must name a module or function dependency');
  }
  const used = new Set<CapabilityName>();
  for (const group of groups.values()) {
    if (group.modules.size !== 1) throw new Error('retained executable reference requires one complete module');
    const module = [...group.modules.values()][0];
    if (module.symbolTable.kind !== 'SymbolTable') throw new Error('retained executable module lacks symbol table');
    const declarations = new Map<SymbolId, { root: NodeRef; declaration: Decl }>();
    for (const member of module.members) {
      if (member.kind === 'FunctionDecl') {
        if (declarations.has(member.symbol)) throw new Error('duplicate retained declaration');
        declarations.set(member.symbol, { root: new GraphStore().intern(member), declaration: member });
      } else if (member.kind !== 'TypeDecl') throw new Error('unresolved import or dynamic retained declaration lifecycle');
    }
    const additional: Decl[] = [];
    for (const [symbol, dependency] of group.dependencies) {
      const old = declarations.get(symbol);
      if (old && old.root !== dependency.root) throw new Error('conflicting retained dependency declaration');
      if (!old) { declarations.set(symbol, dependency); additional.push(dependency.declaration); }
    }
    if (declarations.size > 128) throw new RangeError('retained adapter liveness declaration bound');
    const combined: Module = { ...module, members: [...module.members, ...additional] };
    const nodes = [...walk(combined)];
    if (nodes.length > 10_000 || nodes.some(node => dynamic.has(node.kind))) throw new Error('unresolved import or dynamic retained adapter liveness');
    if (!typecheck(combined, { registry }).ok) throw new Error('ill-typed retained executable closure');
    for (const { declaration } of declarations.values()) {
      declaration.capabilities.forEach(capability => used.add(capability));
      for (const node of walk(declaration)) {
        if (node.kind === 'Call' && !declarations.has(node.callee)) throw new Error('missing retained dependency callee');
        if (node.kind === 'Invoke') used.add(node.capability);
      }
    }
  }
  return used;
}
