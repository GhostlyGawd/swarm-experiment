"""R04 bounded numerical and actual pretrained-model LoRA experiment; no remote execution."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import time
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np
from mlx.utils import tree_flatten
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers, load_adapters

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def gradients(profile):
    mx.random.seed(profile['seed'])
    p = profile['relaxation']
    x = mx.array(p['developmentInputs'], dtype=mx.float32)
    offsets = mx.array([-1.0, 0.0, 1.0])
    def loss(logits, noise):
        weights = mx.softmax((logits + noise) / p['temperature'])
        prediction = x + mx.sum(weights * offsets)
        return mx.mean((prediction - (x + 1)) ** 2)
    logits = mx.zeros((3,))
    # Deterministic finite differences test the same reparameterized noise.
    noise = mx.array([0.13, -0.27, 0.05], dtype=mx.float32)
    analytical = mx.grad(loss)(logits, noise)
    epsilon = 0.001
    numerical = []
    for index in range(3):
        direction = mx.array([epsilon if i == index else 0 for i in range(3)])
        numerical.append(float((loss(logits + direction, noise) - loss(logits - direction, noise)) / (2 * epsilon)))
    error = max(abs(float(analytical[i]) - numerical[i]) for i in range(3))
    assert error < 0.001, error
    trace = []
    for step in range(p['iterations']):
        uniform = mx.random.uniform(low=1e-6, high=1-1e-6, shape=(3,))
        gumbel = -mx.log(-mx.log(uniform))
        value, gradient = mx.value_and_grad(loss)(logits, gumbel)
        mx.eval(value, gradient)
        assert bool(mx.all(mx.isfinite(gradient)))
        logits = logits - p['learningRate'] * gradient
        mx.eval(logits)
        trace.append({'step':step+1,'loss':float(value),'gradientNorm':float(mx.sqrt(mx.sum(gradient*gradient)))})
    selected = int(mx.argmax(logits))
    heldout_exact = all(v + selected - 1 == v + 1 for v in p['heldoutInputs'])
    fuzz = profile['gradientFuzzing']
    fuzz_rows = []
    for split, targets in [('development',fuzz['developmentTargets']),('heldout',fuzz['heldoutTargets'])]:
        for target in targets:
            variable = mx.array(float(fuzz['initialInput']), dtype=mx.float32)
            concrete_probes = 0
            found = None
            for step in range(fuzz['maximumIterations']+1):
                actual = float(variable)
                candidates = sorted(set([round(actual),math.floor(actual),math.ceil(actual)]))
                for candidate in candidates:
                    concrete_probes += 1
                    if 0 <= candidate <= 127 and candidate == target:
                        found = step
                        break
                if found is not None or step == fuzz['maximumIterations']:
                    break
                gradient = mx.grad(lambda value: mx.abs(value-target))(variable)
                variable = mx.clip(variable-fuzz['stepSize']*gradient,*fuzz['inputBounds'])
                mx.eval(variable)
            fuzz_rows.append({'split':split,'target':target,'iterations':found,'concreteProbes':concrete_probes,'success':found is not None})
    return {'finiteDifferenceMaximumError':error,'relaxationTrace':trace,'selectedCandidate':p['candidates'][selected],
            'heldoutDiscreteCorrect':heldout_exact,'fuzzing':fuzz_rows,'heldoutFuzzingVerdict':'pass' if all(r['success'] for r in fuzz_rows if r['split']=='heldout') else 'fail'}


def boundary_rate(profile):
    p=profile['boundaryRate']
    samples=[]
    checksum=0
    for trial in range(p['warmups']+p['trials']):
        started=time.perf_counter()
        for index in range(p['inputsPerTrial']):
            # Distinct event sequence numbers; serialize and concretely execute every fixture.
            frame=json.dumps({'order':index%24,'sequence':index,'allocation':(index*31)%4097,'checksum':(index*17)%256},separators=(',',':'))
            event=json.loads(frame)
            coverage=(event['order']!=0)+(event['sequence']%7==0)*2+(event['allocation']>4095)*4+(event['checksum']==255)*8
            checksum=(checksum+coverage)&0xffffffff
        elapsed=time.perf_counter()-started
        if trial>=p['warmups']:
            rate=p['inputsPerTrial']/elapsed
            samples.append({'seconds':elapsed,'inputs':p['inputsPerTrial'],'inputsPerSecond':rate,'verdict':'pass' if rate>=p['minimumPerSecond'] else 'fail'})
    return {'samples':samples,'checksum':checksum,'verdict':'pass' if all(s['verdict']=='pass' for s in samples) else 'fail',
            'qualification':'local JSON event fixture only; full distributed micro-world is not measured'}


def tensor_fingerprint(model, include_adapters=False):
    result=hashlib.sha256()
    for name,value in sorted(tree_flatten(model.parameters())):
        if not include_adapters and ('lora_a' in name or 'lora_b' in name):
            continue
        # Conversion to LoRALinear wraps a frozen base linear layer.
        canonical_name=name.replace('.linear.', '.')
        result.update(canonical_name.encode())
        result.update(np.asarray(value.astype(mx.float32)).tobytes())
    return result.hexdigest()


def train_lora(profile, model_record, output):
    p=profile['lora']
    record=json.loads(Path(model_record).read_text())
    assert record['id']==p['model']
    for file in record['files']:
        assert digest(Path(record['path'])/file['path'])==file['sha256'],file['path']
    started=time.perf_counter()
    model,tokenizer=load(record['path'])
    model.eval()
    base_before=tensor_fingerprint(model)
    train=[f'Return the Aether integer literal for {i}.\nAnswer: (int {i})' for i in range(1,13)]
    heldout=[f'Return the Aether integer literal for {i}.\nAnswer: (int {i})' for i in [101,103,107,109]]
    assert set(train).isdisjoint(heldout)
    corpus={'train':train,'heldout':heldout}
    (output/'corpus.json').write_text(json.dumps(corpus,indent=2)+'\n')
    def batch(text):
        ids=tokenizer.encode(text)
        assert 1<len(ids)<=p['maximumSequenceLength']
        return mx.array([ids],dtype=mx.int32)
    training=[batch(text) for text in train]
    testing=[batch(text) for text in heldout]
    tokens=sum(x.size-1 for x in training)
    assert tokens<=p['maximumTrainingTokens']
    def loss(model,values):
        logits=model(values[:,:-1]).astype(mx.float32)
        return nn.losses.cross_entropy(logits,values[:,1:],reduction='mean')
    baseline=[float(loss(model,values)) for values in testing]
    model.freeze()
    config={'rank':p['rank'],'scale':p['alpha']/p['rank'],'dropout':0.0,'keys':['self_attn.q_proj','self_attn.v_proj']}
    linear_to_lora_layers(model,p['adaptedLayers'],config)
    trainable_before={name:np.asarray(value).copy() for name,value in tree_flatten(model.trainable_parameters())}
    assert trainable_before and all('lora_' in name for name in trainable_before)
    optimizer=optim.Adam(learning_rate=p['learningRate'])
    value_and_grad=nn.value_and_grad(model,loss)
    rows=[]
    train_start=time.perf_counter()
    for step in range(p['steps']):
        if time.perf_counter()-started>p['maximumExperimentSeconds']:
            raise TimeoutError('fixed experiment wall-clock budget exceeded')
        step_start=time.perf_counter()
        value,gradient=value_and_grad(model,training[step%len(training)])
        flat=tree_flatten(gradient)
        norm=mx.sqrt(sum(mx.sum(v.astype(mx.float32)**2) for _,v in flat))
        mx.eval(value,norm)
        assert math.isfinite(float(value)) and math.isfinite(float(norm))
        optimizer.update(model,gradient)
        mx.eval(model.parameters(),optimizer.state)
        rows.append({'step':step+1,'loss':float(value),'gradientNorm':float(norm),'seconds':time.perf_counter()-step_start})
    train_seconds=time.perf_counter()-train_start
    base_after=tensor_fingerprint(model)
    assert base_before==base_after,'frozen base changed'
    final=dict(tree_flatten(model.trainable_parameters()))
    assert any(not np.array_equal(trainable_before[name],np.asarray(value)) for name,value in final.items())
    assert any(row['gradientNorm']>0 for row in rows)
    adapter=output/'adapter';adapter.mkdir(exist_ok=True)
    (adapter/'adapter_config.json').write_text(json.dumps({'fine_tune_type':'lora','num_layers':p['adaptedLayers'],'lora_parameters':config},indent=2)+'\n')
    mx.save_safetensors(str(adapter/'adapters.safetensors'),final)
    after=[float(loss(model,values)) for values in testing]
    reload_start=time.perf_counter()
    fresh,_=load(record['path'])
    fresh.freeze();load_adapters(fresh,str(adapter));fresh.eval()
    differences=[]
    for values in testing:
        difference=mx.max(mx.abs(model(values[:,:-1]).astype(mx.float32)-fresh(values[:,:-1]).astype(mx.float32)))
        differences.append(float(difference))
    reload_seconds=time.perf_counter()-reload_start
    assert max(differences)<=0.0001,'reloaded adapter mismatch'
    assert tensor_fingerprint(fresh)==base_before
    return {'model':{k:v for k,v in record.items() if k!='path'},'baseTensorSHA256':base_before,'baseUnchanged':True,
            'trainingTokens':tokens,'trainingSteps':rows,'trainingSeconds':train_seconds,'trainableParameters':sum(v.size for v in final.values()),
            'heldoutLossBefore':baseline,'heldoutLossAfter':after,'heldoutMeanBefore':sum(baseline)/len(baseline),'heldoutMeanAfter':sum(after)/len(after),
            'reloadMaximumLogitError':max(differences),'reloadSeconds':reload_seconds,'adapterSHA256':digest(adapter/'adapters.safetensors'),
            'adapterBytes':(adapter/'adapters.safetensors').stat().st_size,'corpusSHA256':digest(output/'corpus.json'),'totalSeconds':time.perf_counter()-started,
            'verdict':'pass','scope':'actual pretrained transformer train/save/reload path, not verified code synthesis or autonomous continual tuning'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model-record',required=True);parser.add_argument('--output',default=str(HERE/'results'))
    args=parser.parse_args();output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    profile=json.loads((HERE/'profile.json').read_text())
    mx.random.seed(profile['seed'])
    environment={'platform':platform.platform(),'python':platform.python_version(),'device':mx.device_info(),
                 'packages':{name:importlib.metadata.version(name) for name in ['mlx','mlx-lm','numpy','transformers','tokenizers','huggingface-hub']}}
    result={'format':'aether.learning-research-run/1','profileSHA256':digest(HERE/'profile.json'),'scriptSHA256':digest(__file__),'environment':environment}
    result['gradients']=gradients(profile)
    result['boundaryRate']=boundary_rate(profile)
    (output/'numerical-results.json').write_text(json.dumps(result,indent=2)+'\n')
    result['lora']=train_lora(profile,args.model_record,output)
    result['peakMemoryBytes']=mx.get_peak_memory()
    (output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'boundaryVerdict':result['boundaryRate']['verdict'],'gradientVerdict':result['gradients']['heldoutFuzzingVerdict'],'lora':result['lora']},indent=2),flush=True)


if __name__=='__main__':
    main()
