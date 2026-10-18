"""Make resumable 1 MiB static downloads, preserving original model files/hashes.

Run after exporting/updating browser assets. CPU only; no model re-scoring.
Cloudflare's static asset host need not support HTTP byte ranges. JSON, ONNX,
and WebAssembly pieces use gzip when it saves at least 10%; FP4 stays packed.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path


def prepare(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    root = manifest_path.parents[1]
    output = manifest_path.parent / 'parts'
    output.mkdir(exist_ok=True)
    assets = [*manifest['tokenizer'].values(), *manifest['positions'].values(),
              *manifest.get('cpuRuntime', {}).values()]
    for group in ['graphs', 'cpuGraphs']:
        for graph in manifest.get(group, {}).values():
            assets.extend([graph, *graph.get('steps', [])])
    for source in manifest['sources'].values():
        assets.extend(source['chunks'])
    pieces = {}
    original_bytes = 0
    for asset in assets:
        path = root / asset['url'].lstrip('/')
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == asset['sha256'], path
        if len(data) <= 1024 * 1024:
            continue
        parts = []
        for offset in range(0, len(data), 1024 * 1024):
            raw = data[offset:offset + 1024 * 1024]
            stored = raw
            compressed = False
            if path.suffix in {'.json', '.wasm', '.onnx'}:
                candidate = gzip.compress(raw, compresslevel=6, mtime=0)
                if len(candidate) < len(raw) * .9:
                    stored, compressed = candidate, True
            digest = hashlib.sha256(stored).hexdigest()
            file = output / f'{digest}.{"gz" if compressed else "bin"}'
            if not file.exists():
                file.write_bytes(stored)
            part = dict(url=f'/model/parts/{file.name}', sha256=digest, bytes=len(stored))
            if compressed:
                part.update(compression='gzip', decodedBytes=len(raw))
            parts.append(part)
            if digest not in pieces:
                original_bytes += len(raw)
                pieces[digest] = len(stored)
        asset['parts'] = parts
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(dict(parts=len(pieces), decoded_bytes=original_bytes,
                          download_bytes=sum(pieces.values()))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path('public/model/manifest-v4-fp4.json'))
    prepare(parser.parse_args().manifest)
