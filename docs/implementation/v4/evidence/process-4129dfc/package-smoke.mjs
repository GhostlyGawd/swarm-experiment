import * as b from './package/dist/tier1/build.js';
import { SymbolSpace } from './package/dist/tier1/symbols.js';
import { CapabilityRegistry } from './package/dist/tier2/ocap.js';
import { createEvidenceManifest, domainDigest } from './package/dist/fabric/index.js';
import { ProcessChannel } from './package/dist/tier4/index.js';
import { ProcessHost, ProcessDeployment } from './package/dist/index.js';
import assert from 'node:assert/strict';
const s = new SymbolSpace('package-verification'), main = s.define('main');
const module = b.module_({symbol:s.define('module'),members:[b.fn({symbol:main,params:[],returns:b.Int,body:b.block(b.ret(b.int(42)))})],symbolTable:s.table()});
const registry = new CapabilityRegistry(), digest = value => domainDigest('aether.package-test/1',value);
const manifest=createEvidenceManifest({module,registry,specification:'Packaged worker returns42',semanticsVersion:'reference/1',compilerDigest:digest('compiler'),capabilityPolicyDigest:digest('policy'),target:{abiVersion:'local/1',profileDigest:digest('profile'),artifactDigest:digest('artifact')}});
assert.equal(typeof ProcessHost.open,'function');assert.equal(typeof ProcessDeployment.open,'function');
const worker=await ProcessChannel.start({module,manifest,unit:'worker',includeSymbols:[main],capabilities:[],heapId:'heap-package',ownershipEpoch:'0'});
try {const result=await worker.call(main,[],await worker.snapshot(),{operationId:'package-call'});assert.equal(result.execution.ok,true);assert.equal(result.execution.value,42n);assert.notEqual(result.pid,process.pid);console.log('Packaged worker returned42 in actual child process from path with spaces.');} finally {await worker.close();}
