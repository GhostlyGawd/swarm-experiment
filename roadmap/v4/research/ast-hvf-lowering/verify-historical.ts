/** Replay retained AST→HVF guest evidence with the exact registered source.
 * Later runtime work must not invalidate an archived guest measurement. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../../../..');
const retained=join(here,'results/local-01');
const report=JSON.parse(readFileSync(join(retained,'report.json'),'utf8'));
if(report.format!=='aether.ast-hvf-lowering-research/1'||!/^[0-9a-f]{40}$/.test(report.gitCommit))
  throw new TypeError('invalid AST guest source pin');
const folder=mkdtempSync(join(tmpdir(),'aether-ast-hvf-history-')), checkout=join(folder,'source');
try{
  execFileSync('git',['worktree','add','--detach',checkout,report.gitCommit],{cwd:root,stdio:'ignore'});
  symlinkSync(join(root,'node_modules'),join(checkout,'node_modules'),'dir');
  const results=join(checkout,'roadmap/v4/research/ast-hvf-lowering/results');
  mkdirSync(results,{recursive:true});symlinkSync(retained,join(results,'local-01'),'dir');
  const output=execFileSync(process.execPath,['--experimental-strip-types',
    join(checkout,'roadmap/v4/research/ast-hvf-lowering/verify.ts')],
    {cwd:checkout,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
  process.stdout.write(output);
}finally{
  try{execFileSync('git',['worktree','remove','--force',checkout],{cwd:root,stdio:'ignore'});}
  finally{rmSync(folder,{recursive:true,force:true});}
}
