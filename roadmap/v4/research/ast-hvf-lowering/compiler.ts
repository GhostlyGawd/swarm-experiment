/** Research compiler: a checked Tier 1 AST subset to freestanding AArch64 C. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Term, Ty } from '../../../../src/tier1/ast.ts';
import type { SymbolId } from '../../../../src/tier1/ids.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { executionManifestDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { compileResumableProgram } from '../../../../src/tier3/resumable-program.ts';

const here = dirname(fileURLToPath(import.meta.url));
const i64Min = -(1n << 63n), i64Max = (1n << 63n) - 1n;
const ident = (n: number) => `a${n}`;
export const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export interface FieldLayout { readonly name: string; readonly min: bigint; readonly max: bigint; readonly bits: number }
export interface LoweringInput {
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly entry: SymbolId;
  readonly fields?: readonly FieldLayout[];
}
export interface LoweredGuest {
  readonly entry: SymbolId;
  readonly manifestDigest: string;
  readonly root: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly params: readonly Ty[];
  readonly fields: readonly FieldLayout[];
  readonly recordParam: number | null;
  readonly result: 'Int' | 'Bool';
}

function requireI64(n: bigint, label: string): bigint {
  if (n < i64Min || n > i64Max) throw new TypeError(`${label} outside signed 64-bit subset`);
  return n;
}
function cI64(n: bigint): string { return `((int64_t)UINT64_C(${BigInt.asUintN(64, n)}))`; }
function scalar(ty: Ty): ty is { t: 'Int' } | { t: 'Bool' } { return ty.t === 'Int' || ty.t === 'Bool'; }

export function lowerAstToGuest(input: LoweringInput): LoweredGuest {
  const { module, manifest, entry } = input;
  if (module.kind !== 'Module' || module.members.some(member => member.kind !== 'FunctionDecl') || manifest.target.abiVersion !== 'ast-hvf-research/1')
    throw new TypeError('AST guest requires a direct-declaration module and research ABI');
  const root = new GraphStore().intern(module);
  if (root !== manifest.astRoot || manifest.semanticsVersion !== 'aether-reference/1') throw new TypeError('AST root or semantics mismatch');
  // Reuse production type, capability and dependency closure validation before narrowing.
  compileResumableProgram(module, { manifest, registry: new CapabilityRegistry() });
  const functions = module.members.filter((member): member is Extract<Term, { kind: 'FunctionDecl' }> => member.kind === 'FunctionDecl');
  const fn = functions.find(member => member.symbol === entry);
  if (!fn || functions.length !== 1 || fn.body === null || fn.purity !== 'pure' || fn.capabilities.length || fn.contract || fn.surfaces.length || fn.typeParams.length || !scalar(fn.returns))
    throw new TypeError('unsupported entry, declaration, effect, contract or result');
  if (fn.params.length > 8 || new Set(fn.params.map(param => param.symbol)).size !== fn.params.length)
    throw new TypeError('unsupported parameter count or duplicate binding');
  const records = fn.params.map((param, index) => param.ty.t === 'Record' ? index : -1).filter(index => index >= 0);
  if (records.length > 1) throw new TypeError('one packed record parameter at most');
  const recordParam = records[0] ?? null;
  if (fn.params.some(param => !scalar(param.ty) && param.ty.t !== 'Record')) throw new TypeError('unsupported parameter type');
  const fields = input.fields ?? [];
  if (recordParam === null && fields.length) throw new TypeError('field layout without record parameter');
  if (recordParam !== null) {
    const ty = fn.params[recordParam]!.ty as Extract<Ty, { t: 'Record' }>;
    if (fields.length !== ty.fields.length || fields.length > 16 || fields.some((field, index) => field.name !== ty.fields[index]![0] || ty.fields[index]![1].t !== 'Int' ||
      field.bits < 1 || field.bits > 63 || !Number.isInteger(field.bits) || field.min > field.max || field.min < i64Min || field.max > i64Max ||
      field.max - field.min >= (1n << BigInt(field.bits)))) throw new TypeError('packed field layout does not match record schema or bounds');
  }
  const binding = new Map(fn.params.map((param, index) => [param.symbol, { type: param.ty, index }]));
  let nodes = 0;
  const expression = (term: Term, depth = 0): { code: string; type: 'Int' | 'Bool' } => {
    if (++nodes > 256 || depth > 32) throw new TypeError('AST guest expression resource bound');
    switch (term.kind) {
      case 'Lit':
        if (term.ty.t === 'Int' && typeof term.value === 'bigint') return { code: cI64(requireI64(term.value, 'literal')), type: 'Int' };
        if (term.ty.t === 'Bool' && typeof term.value === 'boolean') return { code: term.value ? '1' : '0', type: 'Bool' };
        break;
      case 'Var': {
        const item = binding.get(term.symbol);
        if (item && scalar(item.type)) return { code: ident(item.index), type: item.type.t };
        break;
      }
      case 'Field': {
        if (recordParam === null || term.object.kind !== 'Var' || term.object.symbol !== fn.params[recordParam]!.symbol) break;
        const index = fields.findIndex(field => field.name === term.field);
        if (index < 0) break;
        const offset = fields.slice(0, index).reduce((sum, field) => sum + field.bits, 0);
        const field = fields[index]!;
        return { code: `ae_field(frame, capacity, ${offset}u, ${field.bits}u, ${cI64(field.min)}, ${cI64(field.max)}, status)`, type: 'Int' };
      }
      case 'Un': {
        const a = expression(term.operand, depth + 1);
        if (term.op === 'neg' && a.type === 'Int') return { code: `ae_sub(0, ${a.code}, status)`, type: 'Int' };
        if (term.op === 'not' && a.type === 'Bool') return { code: `(!(${a.code}))`, type: 'Bool' };
        break;
      }
      case 'Bin': {
        const a = expression(term.left, depth + 1), b = expression(term.right, depth + 1);
        if (['add', 'sub', 'mul', 'div', 'mod'].includes(term.op) && a.type === 'Int' && b.type === 'Int')
          return { code: `ae_${term.op}(${a.code}, ${b.code}, status)`, type: 'Int' };
        if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(term.op) && a.type === b.type)
          return { code: `((${a.code}) ${ { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' }[term.op as 'eq'] } (${b.code}))`, type: 'Bool' };
        if (term.op === 'and' && a.type === 'Bool' && b.type === 'Bool') return { code: `((${a.code}) && (${b.code}))`, type: 'Bool' };
        if (term.op === 'or' && a.type === 'Bool' && b.type === 'Bool') return { code: `((${a.code}) || (${b.code}))`, type: 'Bool' };
        break;
      }
      case 'Cond': {
        const c = expression(term.cond, depth + 1), a = expression(term.then, depth + 1), b = expression(term.otherwise, depth + 1);
        if (c.type === 'Bool' && a.type === b.type) return { code: `((${c.code}) ? (${a.code}) : (${b.code}))`, type: a.type };
        break;
      }
    }
    throw new TypeError(`unsupported AST expression ${term.kind}`);
  };
  const statement = (term: Term, depth = 0): string => {
    if (++nodes > 256 || depth > 32) throw new TypeError('AST guest statement resource bound');
    if (term.kind === 'Return') {
      const value = expression(term.value, depth + 1);
      if (value.type !== fn.returns.t) throw new TypeError('return type mismatch');
      return `return ${value.code};`;
    }
    if (term.kind === 'Block') {
      if (!term.stmts.length || term.stmts.some((child, index) => index < term.stmts.length - 1 && child.kind === 'Return')) throw new TypeError('unsupported fallthrough block');
      return `{ ${term.stmts.map(child => statement(child, depth + 1)).join('\n')} }`;
    }
    if (term.kind === 'If' && term.otherwise !== null) {
      const c = expression(term.cond, depth + 1);
      if (c.type !== 'Bool') throw new TypeError('non-Boolean branch');
      return `if (${c.code}) ${statement(term.then, depth + 1)} else ${statement(term.otherwise, depth + 1)}`;
    }
    throw new TypeError(`unsupported AST statement ${term.kind}`);
  };
  const body = statement(fn.body);
  const digest = executionManifestDigest(manifest), digestBytes = digest.slice(digest.lastIndexOf(':') + 1);
  const source = `/* Generated from Tier 1 AST root ${root}. Research subset only. */\n#include <stdint.h>\n#include <stddef.h>\n#define MAGIC UINT32_C(0x46454841)\n#define DONE UINT32_C(0x454e4f44)\n#define HEADER 96u\n#define ARGS ${fn.params.length}u\n#define BITS ${fields.reduce((sum, field) => sum + field.bits, 0)}u\n#define MAYBE_UNUSED __attribute__((unused))\nstatic const uint8_t expected_digest[32]={${digestBytes.match(/../g)!.map(byte => `0x${byte}`).join(',')}};\nstatic uint32_t rd32(const volatile uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}\nstatic MAYBE_UNUSED uint64_t rd64(const volatile uint8_t*p){return (uint64_t)rd32(p)|((uint64_t)rd32(p+4)<<32);}\nstatic void wr32(volatile uint8_t*p,uint32_t n){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(n>>(8*i));}\nstatic void wr64(volatile uint8_t*p,uint64_t n){for(unsigned i=0;i<8;i++)p[i]=(uint8_t)(n>>(8*i));}\nstatic MAYBE_UNUSED int64_t ae_add(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_add_overflow(a,b,&r))*s=1;return r;}\nstatic MAYBE_UNUSED int64_t ae_sub(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_sub_overflow(a,b,&r))*s=1;return r;}\nstatic MAYBE_UNUSED int64_t ae_mul(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_mul_overflow(a,b,&r))*s=1;return r;}\nstatic MAYBE_UNUSED int64_t ae_div(int64_t a,int64_t b,uint32_t*s){if(!b){*s=2;return 0;}if(a==INT64_MIN&&b==-1){*s=1;return 0;}return a/b;}\nstatic MAYBE_UNUSED int64_t ae_mod(int64_t a,int64_t b,uint32_t*s){if(!b){*s=2;return 0;}if(a==INT64_MIN&&b==-1){*s=1;return 0;}return a%b;}\nstatic MAYBE_UNUSED int64_t ae_field(const volatile uint8_t*f,uint64_t cap,uint32_t off,uint32_t width,int64_t min,int64_t max,uint32_t*s){uint32_t at=HEADER+ARGS*8u;if(off> BITS||width>BITS-off||at+(BITS+7u)/8u>cap){*s=3;return 0;}uint64_t code=0;for(uint32_t i=0;i<width;i++)code|=(uint64_t)((f[at+(off+i)/8u]>>((off+i)%8u))&1u)<<i;__int128 value=(__int128)min+code;if(value>max){*s=3;return 0;}return (int64_t)value;}\nstatic int64_t execute(const volatile uint8_t*frame,uint64_t capacity,uint32_t*status){(void)frame;(void)capacity;(void)status;${fn.params.map((param, index) => scalar(param.ty) ? `int64_t ${ident(index)}=(int64_t)rd64(frame+HEADER+${index}u*8u);` : '').join('')} ${body}}\nuint64_t aether_ast_guest(uint8_t*bytes,uint64_t capacity){volatile uint8_t*frame=bytes;if(!frame||capacity!=HEADER+ARGS*8u+(BITS+7u)/8u||capacity>32768u||rd32(frame)!=MAGIC||rd32(frame+4)!=1u||rd32(frame+8)!=capacity||rd32(frame+12)!=ARGS||rd32(frame+16)!=BITS||rd32(frame+20)!=(BITS+7u)/8u||rd32(frame+40)!=0u)return 1;for(unsigned i=0;i<32;i++)if(frame[48+i]!=expected_digest[i])return 2;${fn.params.map((param, index) => param.ty.t === 'Bool' ? `if(rd64(frame+HEADER+${index}u*8u)>1u)return 3;` : '').join('')}if(BITS%8u&&((frame[HEADER+ARGS*8u+(BITS/8u)]>>(BITS%8u))!=0u))return 4;uint32_t status=0;int64_t value=execute(frame,capacity,&status);wr32(frame+24,status);wr32(frame+28,${fn.returns.t === 'Bool' ? '2u' : '1u'});wr64(frame+32,(uint64_t)value);wr32(frame+40,DONE);return 0;}\n`;
  return { entry, manifestDigest: digest, root, source, sourceSha256: sha256(Buffer.from(source)), params: fn.params.map(param => param.ty), fields, recordParam, result: fn.returns.t };
}

export function buildGuest(lowered: LoweredGuest, output: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon Hypervisor.framework target required');
  mkdirSync(output, { recursive: true });
  const sourcePath = join(output, 'guest.c'); writeFileSync(sourcePath, lowered.source);
  const linker = join(execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim(), 'lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld.lld');
  const cc = ['-target', 'aarch64-none-elf', '-ffreestanding', '-fno-stack-protector', '-fno-builtin', '-nostdlib', '-Wall', '-Wextra', '-Werror'];
  execFileSync('clang', [...cc, '-O2', '-c', sourcePath, '-o', join(output, 'guest.o')]);
  execFileSync('clang', [...cc, '-c', join(here, 'start.S'), '-o', join(output, 'start.o')]);
  const objects = [join(output, 'start.o'), join(output, 'guest.o')];
  const image = join(output, 'guest.bin'), elf = join(output, 'guest.elf');
  execFileSync(linker, ['-T', join(here, 'kernel.ld'), ...objects, '-o', elf]);
  execFileSync(linker, ['-T', join(here, 'kernel.ld'), '--oformat=binary', ...objects, '-o', image]);
  const bytes = readFileSync(image);
  if (!bytes.length || bytes.length > 16384 || readFileSync(elf).readBigUInt64LE(24) !== 0x40000000n) throw new TypeError('guest image ABI/size');
  const driver = join(output, 'driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'), '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', join(here, '../native/hypervisor.entitlements'), driver]);
  return { image, elf, driver, imageSha256: sha256(bytes), driverSha256: sha256(readFileSync(driver)), sourceSha256: lowered.sourceSha256,
    compiler: execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0], linker: execFileSync(linker, ['--version'], { encoding: 'utf8' }).trim() };
}

export function encodeFrame(lowered: LoweredGuest, args: readonly (bigint | boolean | Readonly<Record<string, bigint>>)[]): Buffer {
  if (args.length !== lowered.params.length) throw new TypeError('argument arity mismatch');
  const bits = lowered.fields.reduce((sum, field) => sum + field.bits, 0), size = 96 + args.length * 8 + Math.ceil(bits / 8);
  const frame = Buffer.alloc(size); frame.writeUInt32LE(0x46454841, 0); frame.writeUInt32LE(1, 4);
  frame.writeUInt32LE(size, 8); frame.writeUInt32LE(args.length, 12); frame.writeUInt32LE(bits, 16); frame.writeUInt32LE(Math.ceil(bits / 8), 20);
  Buffer.from(lowered.manifestDigest.slice(lowered.manifestDigest.lastIndexOf(':') + 1), 'hex').copy(frame, 48);
  for (let i = 0; i < args.length; i++) {
    const ty = lowered.params[i]!, value = args[i];
    if (ty.t === 'Int' && typeof value === 'bigint') frame.writeBigInt64LE(requireI64(value, 'argument'), 96 + i * 8);
    else if (ty.t === 'Bool' && typeof value === 'boolean') frame.writeBigUInt64LE(value ? 1n : 0n, 96 + i * 8);
    else if (ty.t === 'Record' && value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length !== lowered.fields.length || lowered.fields.some(field => !Object.hasOwn(value, field.name))) throw new TypeError('record field mismatch');
      let bit = 0;
      for (const field of lowered.fields) {
        const v = (value as Record<string, bigint>)[field.name];
        if (typeof v !== 'bigint' || v < field.min || v > field.max) throw new TypeError('record field outside packed bounds');
        const code = v - field.min;
        for (let j = 0; j < field.bits; j++, bit++) if ((code >> BigInt(j)) & 1n) frame[96 + args.length * 8 + (bit >> 3)]! |= 1 << (bit & 7);
      }
    } else throw new TypeError('argument type mismatch');
  }
  return frame;
}
