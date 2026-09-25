import type { Term } from './ast.ts';
import type { NodeRef, SymbolId } from './ids.ts';
import type { GraphStore } from './store.ts';

export interface ResolvedModule {
  readonly module: Extract<Term, { kind: 'Module' }>;
  readonly dependencies: readonly NodeRef[];
}

/** Resolves exact-address imports into one linked module without name guessing. */
export class ModuleResolver {
  private readonly store: GraphStore;
  constructor(store: GraphStore) {
    this.store = store;
  }

  resolve(root: NodeRef): ResolvedModule {
    const visiting = new Set<NodeRef>();
    const resolved = new Set<NodeRef>();
    const dependencies: NodeRef[] = [];

    const linkMembers = (hydrated: Extract<Term, { kind: 'Module' }>): Extract<Term, { kind: 'Module' }> => {
      const localMembers = hydrated.members.filter((member) => member.kind !== 'Import').map(member =>
        member.kind === 'Module' ? linkMembers(member) : member);
      const importedMembers: Term[] = [];
      const importedNames: Array<readonly [SymbolId, string]> = [];
      for (const declaration of hydrated.members) {
        if (declaration.kind !== 'Import') continue;
        const dependency = link(declaration.module);
        if (!resolved.has(declaration.module)) {
          resolved.add(declaration.module);
          dependencies.push(declaration.module);
        }
        const allowed = new Set(declaration.symbols);
        for (const member of dependency.members) {
          if (!('symbol' in member)) continue;
          if (allowed.size === 0 || allowed.has(member.symbol as SymbolId)) importedMembers.push(member);
        }
        if (dependency.symbolTable.kind === 'SymbolTable') {
          for (const entry of dependency.symbolTable.entries) {
            if (allowed.size === 0 || allowed.has(entry[0])) importedNames.push(entry);
          }
        }
      }
      const seen = new Set<SymbolId>();
      for (const member of [...localMembers, ...importedMembers]) {
        if (!('symbol' in member)) continue;
        const symbol = member.symbol as SymbolId;
        if (seen.has(symbol)) throw new Error(`duplicate imported symbol ${symbol}`);
        seen.add(symbol);
      }
      if (!importedMembers.length && !hydrated.members.some(member => member.kind === 'Import'))
        return localMembers.every((member, index) => member === hydrated.members[index]) ? hydrated : { ...hydrated, members: localMembers };
      const localNames = hydrated.symbolTable.kind === 'SymbolTable' ? hydrated.symbolTable.entries : [];
      const names = new Map<SymbolId, string>([...localNames, ...importedNames]);
      return {
        ...hydrated,
        members: [...localMembers, ...importedMembers],
        symbolTable: { kind: 'SymbolTable', entries: [...names].sort((a, b) => a[0].localeCompare(b[0])) },
      };
    };
    const link = (ref: NodeRef): Extract<Term, { kind: 'Module' }> => {
      if (visiting.has(ref)) throw new Error(`module import cycle at ${ref}`);
      const hydrated = this.store.hydrate(ref);
      if (hydrated.kind !== 'Module') throw new TypeError(`import ${ref} is not a module`);
      visiting.add(ref);
      try { return linkMembers(hydrated); }
      finally { visiting.delete(ref); }
    };

    return { module: link(root), dependencies };
  }
}
