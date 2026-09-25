import type { Term } from '../tier1/ast.ts';
import type { CommitRef, SymbolId } from '../tier1/ids.ts';
import type { AetherRepository } from '../tier1/repository.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { parseTypeScript } from './parse.ts';
import { TypeScriptProjector } from './typescript.ts';

export interface ProjectionDocument {
  readonly uri: string;
  readonly branch: string;
  readonly commit: CommitRef;
  readonly version: number;
  readonly text: string;
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: string | number; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: string | number; readonly error: { code: number; message: string } };

export interface ProjectionDiagnostic {
  readonly severity: 1 | 2;
  readonly message: string;
  readonly line: number;
}

export function encodeLspMessage(message: JsonRpcRequest | JsonRpcResponse): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const framed = new Uint8Array(header.length + body.length);
  framed.set(header); framed.set(body, header.length);
  return framed;
}

export class LspStreamDecoder {
  private buffered = new Uint8Array();
  push(chunk: Uint8Array): Array<JsonRpcRequest | JsonRpcResponse> {
    const next = new Uint8Array(this.buffered.length + chunk.length);
    next.set(this.buffered); next.set(chunk, this.buffered.length);
    this.buffered = next;
    const messages: Array<JsonRpcRequest | JsonRpcResponse> = [];
    for (;;) {
      const text = new TextDecoder().decode(this.buffered);
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary < 0) break;
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(text.slice(0, boundary));
      if (!match) throw new SyntaxError('LSP frame has no Content-Length header');
      const headerBytes = new TextEncoder().encode(text.slice(0, boundary + 4)).length;
      const length = Number(match[1]);
      if (this.buffered.length < headerBytes + length) break;
      const body = this.buffered.slice(headerBytes, headerBytes + length);
      messages.push(JSON.parse(new TextDecoder().decode(body)) as JsonRpcRequest | JsonRpcResponse);
      this.buffered = this.buffered.slice(headerBytes + length);
    }
    return messages;
  }
}

export class ProjectionLanguageServer {
  private readonly repository: AetherRepository;
  private readonly symbols: SymbolSpace;
  private version = 0;
  constructor(repository: AetherRepository, symbols: SymbolSpace) {
    this.repository = repository;
    this.symbols = symbols;
  }

  open(branch: string): ProjectionDocument {
    const commit = this.repository.resolve(branch);
    if (!commit) throw new ReferenceError(`unknown branch ${branch}`);
    const module = this.repository.store.hydrate(commit.root);
    const projector = new TypeScriptProjector(this.symbols);
    return {
      uri: `aether://${branch}`, branch, commit: commit.id,
      version: ++this.version, text: projector.decl(module),
    };
  }

  apply(branch: string, text: string, expected: CommitRef): ProjectionDocument {
    const current = this.repository.readCommit(expected);
    const module = this.repository.store.hydrate(current.root);
    const table = module.kind === 'Module' ? module.symbolTable : null;
    const bindings = new Map<string, SymbolId>();
    if (table?.kind === 'SymbolTable') for (const [symbol, name] of table.entries) bindings.set(name, symbol);
    const projector = new TypeScriptProjector(this.symbols);
    const parsed = parseTypeScript(text, { symbols: this.symbols, bindings, typeNames: projector.typeNames });
    const root = this.repository.store.intern(parsed);
    const commit = this.repository.createCommit(root, {
      parents: [expected], message: `projection edit ${branch}`,
    });
    this.repository.updateRef(branch, commit.id, expected);
    return this.open(branch);
  }

  validate(branch: string, text: string): ProjectionDiagnostic[] {
    try {
      const current = this.repository.resolve(branch);
      if (!current) throw new ReferenceError(`unknown branch ${branch}`);
      const module = this.repository.store.hydrate(current.root);
      const table = module.kind === 'Module' ? module.symbolTable : null;
      const bindings = new Map<string, SymbolId>();
      if (table?.kind === 'SymbolTable') for (const [symbol, name] of table.entries) bindings.set(name, symbol);
      parseTypeScript(text, { symbols: this.symbols, bindings });
      return [];
    } catch (error) {
      const line = typeof error === 'object' && error !== null && 'line' in error
        ? Number((error as { line: number }).line) : 1;
      return [{ severity: 1, message: error instanceof Error ? error.message : String(error), line }];
    }
  }

  handle(request: JsonRpcRequest): JsonRpcResponse {
    try {
      if (request.method === 'initialize') {
        return { jsonrpc: '2.0', id: request.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true } } };
      }
      if (request.method === 'aether/open') {
        const { branch } = request.params as { branch: string };
        return { jsonrpc: '2.0', id: request.id, result: this.open(branch) };
      }
      if (request.method === 'aether/apply') {
        const params = request.params as { branch: string; text: string; expected: CommitRef };
        return { jsonrpc: '2.0', id: request.id, result: this.apply(params.branch, params.text, params.expected) };
      }
      if (request.method === 'aether/validate') {
        const params = request.params as { branch: string; text: string };
        return { jsonrpc: '2.0', id: request.id, result: this.validate(params.branch, params.text) };
      }
      throw new Error(`unsupported method ${request.method}`);
    } catch (error) {
      return {
        jsonrpc: '2.0', id: request.id,
        error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
