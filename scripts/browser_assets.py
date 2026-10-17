"""Host the remaining browser assets and the entire SAE encoder on Cloudflare.

CPU only. Existing FP4 matrices and offline puzzle scores are left intact.
Can also upgrade an already-exported manifest without exporting the model again.
"""

import argparse
import hashlib
import json
from pathlib import Path

from huggingface_hub import hf_hub_download
from safetensors import safe_open
from browser_cpu import cpu_graphs


def host_assets(manifest, output, checkpoint=None, sae_checkpoint=None):
    config = json.loads((Path(__file__).resolve().parents[1] / 'data/model.json').read_text())
    weights = output / 'weights'
    weights.mkdir(parents=True, exist_ok=True)

    def asset(data, suffix='bin'):
        digest = hashlib.sha256(data).hexdigest()
        path = weights / f'{digest}.{suffix}'
        if not path.exists():
            path.write_bytes(data)
        return dict(url=f'/model/weights/{path.name}', bytes=len(data), sha256=digest)

    checkpoint = checkpoint or hf_hub_download(config['model'], 'model.safetensors', revision=config['model_revision'])
    with open(checkpoint, 'rb') as file:
        for chunk in manifest['sources']['model']['chunks']:
            if chunk.get('url'):
                continue
            file.seek(chunk['offset'])
            data = file.read(chunk['bytes'])
            if len(data) != chunk['bytes'] or hashlib.sha256(data).hexdigest() != chunk['sha256']:
                raise ValueError('An original model parameter did not match the pinned manifest.')
            chunk.update(asset(data))

    for name in ['tokenizer', 'tokenizer_config']:
        path = hf_hub_download(config['model'], f'{name}.json', revision=config['model_revision'])
        original = json.loads(Path(path).read_text())
        # Whitespace alone takes the original tokenizer above the 25 MiB asset limit.
        data = json.dumps(original, ensure_ascii=False, separators=(',', ':')).encode()
        assert json.loads(data) == original
        manifest['tokenizer'][name] = asset(data, 'json')

    sae_checkpoint = sae_checkpoint or hf_hub_download(
        config['sae'], f"{config['sae_id']}/sae_weights.safetensors", revision=config['sae_revision'])
    source = dict(tensors={}, chunks=[])
    offset = 0
    with safe_open(sae_checkpoint, framework='np') as file:
        width, features = file.get_slice('W_enc').get_shape()
        assert (width, features) == (2560, 65536)
        # Transpose in small pieces so a feature is one contiguous cache read.
        rows_per_chunk = (16 * 1024 * 1024) // (width * 4)
        source['tensors']['W_enc'] = dict(shape=[features, width], dtype='F32', offset=offset, bytes=features * width * 4)
        for first in range(0, features, rows_per_chunk):
            rows = file.get_slice('W_enc')[:, first:min(first + rows_per_chunk, features)].T
            chunk = asset(rows.astype('<f4').tobytes())
            source['chunks'].append(dict(offset=offset, **chunk))
            offset += chunk['bytes']
        for name in ['b_enc', 'threshold']:
            values = file.get_tensor(name)
            chunk = asset(values.astype('<f4').tobytes())
            source['tensors'][name] = dict(shape=list(values.shape), dtype='F32', offset=offset, bytes=chunk['bytes'])
            source['chunks'].append(dict(offset=offset, **chunk))
            offset += chunk['bytes']
        manifest['sae']['inputBias'] = file.get_tensor('b_dec').tolist()
    manifest['sources']['sae'] = source
    manifest['version'] = manifest['version'].replace('-v2', '-v3')
    unique = {chunk['sha256']: chunk for source in manifest['sources'].values() for chunk in source['chunks']}
    manifest['bytes'] = sum(chunk['bytes'] for chunk in unique.values())
    return cpu_graphs(manifest, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path('public/model/manifest-v2-fp4.json'))
    args = parser.parse_args()
    manifest = host_assets(json.loads(args.manifest.read_text()), args.manifest.parent)
    path = args.manifest.with_name(args.manifest.name.replace('-v2', '-v3'))
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    catalog_path = args.manifest.parent.parent / 'puzzles/index.json'
    catalog = json.loads(catalog_path.read_text())
    catalog['browserModel'].update(manifest=f'/model/{path.name}', bytes=manifest['bytes'])
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    print(json.dumps(dict(manifest=str(path), weight_bytes=manifest['bytes'], sae_features=65536,
                          tokenizer_bytes=sum(row['bytes'] for row in manifest['tokenizer'].values()))))


if __name__ == '__main__':
    main()
