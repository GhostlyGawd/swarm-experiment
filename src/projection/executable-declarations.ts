import type { ExecutableTarget } from './executable-runtime.ts';

/** V9 only: a declaration without code is visible but cannot execute. */
export function extendDeclarationRuntime(base: string, target: ExecutableTarget): string {
  if (target === 'typescript') return base + `\nexport function ae_unsynthesized(_symbol:string):V { throw Error('unsynthesized_body'); }\n`;
  if (target === 'python') return base + `\ndef ae_unsynthesized(_symbol): raise RuntimeError('unsynthesized_body')\n`;
  return base + `\npub fn ae_unsynthesized(_symbol:&str)->Value{panic!("unsynthesized_body")}\n`;
}
