"""Fetch only public data files from the immutable revision used in the R04 run."""
import argparse
import hashlib
import json
import os
from pathlib import Path

os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1'
from huggingface_hub import HfApi, snapshot_download

MODEL='HuggingFaceTB/SmolLM2-135M-Instruct'
REVISION='12fd25f77366fa6b3b4b768ec3050bf629380bac'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache',default='/tmp/aether-r04-hf');parser.add_argument('--record',default='/tmp/aether-r04-model.json')
    args=parser.parse_args()
    info=HfApi(token=False).model_info(MODEL,revision=REVISION,files_metadata=True)
    assert info.sha==REVISION
    selected=[f for f in info.siblings if f.rfilename.endswith(('.json','.safetensors')) or f.rfilename in ['README.md','LICENSE']]
    assert sum(f.size or 0 for f in selected)<1_000_000_000
    directory=snapshot_download(MODEL,revision=REVISION,cache_dir=args.cache,token=False,allow_patterns=[f.rfilename for f in selected])
    record={'id':MODEL,'revision':REVISION,'path':directory,'files':[
        {'path':f.rfilename,'size':f.size,'sha256':hashlib.sha256((Path(directory)/f.rfilename).read_bytes()).hexdigest()} for f in selected]}
    Path(args.record).write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps({'model':MODEL,'revision':REVISION,'record':args.record}))


if __name__=='__main__':
    main()
